import { NestFactory } from '@nestjs/core';
import { CommonModule } from '../common/common.module';
import { RedisModule } from '../common/redis/redis.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { ScanTrigger } from '../generated/prisma/enums';
import { QueueModule } from '../queue/queue.module';
import { ScanQueueService } from '../queue/scan-queue.service';
import { Module } from '@nestjs/common';

// Enqueues a scan by hand, for developing and debugging ScanProcessor and
// the rule set against real pull requests.
//
// Why this exists: scan jobs normally reach a worker only via a provider
// webhook, and those are delivered to BACKEND_URL — the deployed host,
// never a laptop. A worker started locally therefore sits idle forever, on
// a Redis that nothing ever writes to. This writes a job to whatever Redis
// REDIS_URL points at, so the local worker has something to pick up.
//
// It reads the PullRequest row from whatever DATABASE_URL points at — which
// may well be production over an SSH tunnel. That is intentional: scanning
// a real PR is the point. Note the resulting Scan and Finding rows are
// written there too, tagged trigger=MANUAL to distinguish them from
// webhook-driven scans.
//
//   pnpm scan:enqueue <pullId>
//   pnpm scan:enqueue --list        # show recent pull requests to pick from
@Module({
  imports: [CommonModule, RedisModule, QueueModule],
})
class EnqueueScanModule {}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      'Usage: pnpm scan:enqueue <pullId>\n' + '       pnpm scan:enqueue --list',
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(EnqueueScanModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);

    if (arg === '--list') {
      const pulls = await prisma.pullRequest.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          externalId: true,
          title: true,
          state: true,
          headSha: true,
          targetBranch: true,
          repository: { select: { path: true } },
        },
      });
      if (pulls.length === 0) {
        console.log('No pull requests in this database.');
        return;
      }
      console.log(`${pulls.length} most recently updated pull request(s):\n`);
      for (const pull of pulls) {
        const sha = pull.headSha ? pull.headSha.slice(0, 8) : '(no head sha)';
        console.log(
          `  ${pull.id}\n` +
            `    ${pull.repository.path} #${pull.externalId} -> ${pull.targetBranch} [${pull.state}] ${sha}\n` +
            `    ${pull.title}\n`,
        );
      }
      return;
    }

    const pull = await prisma.pullRequest.findUnique({
      where: { id: arg },
      select: {
        id: true,
        externalId: true,
        title: true,
        headSha: true,
        provider: true,
        organizationId: true,
        repositoryId: true,
        repository: { select: { path: true } },
      },
    });

    if (!pull) {
      console.error(
        `No pull request with id "${arg}".\n` +
          'Run `pnpm scan:enqueue --list` to see what is available.',
      );
      process.exitCode = 1;
      return;
    }

    // headSha is nullable on PullRequest (a provider may omit it), but the
    // job payload requires it — there is nothing to check out without one.
    if (!pull.headSha) {
      console.error(
        `Pull request ${pull.id} has no headSha, so there is no commit to scan.`,
      );
      process.exitCode = 1;
      return;
    }

    const scanQueue = app.get(ScanQueueService);
    // MANUAL, not WEBHOOK: it skips the webhook dedupe path, so re-running
    // this on a sha that already has a DONE scan starts a fresh attempt
    // rather than silently returning the old one.
    const result = await scanQueue.enqueue({
      organizationId: pull.organizationId,
      repositoryId: pull.repositoryId,
      pullId: pull.id,
      headSha: pull.headSha,
      // Informational only — ScanProcessor diffs against the provider's
      // merge base, not this value, and the GitLab webhook path stores null
      // here too (see WebhooksService).
      baseSha: null,
      provider: pull.provider,
      trigger: ScanTrigger.MANUAL,
    });

    console.log(
      `Enqueued scan for ${pull.repository.path} #${pull.externalId}\n` +
        `  ${pull.title}\n` +
        `  scanId:  ${result.scanId}\n` +
        `  headSha: ${pull.headSha}\n` +
        `  status:  ${result.status}${result.deduplicated ? ' (existing scan reused)' : ''}\n\n` +
        'Watch the worker (`pnpm start:worker:dev`) to see it picked up.',
    );
  } finally {
    await app.close();
  }
}

void main().then(
  () => {
    // BullMQ holds an open ioredis connection that app.close() does not
    // always tear down, which would leave this one-shot script hanging
    // instead of returning to the shell. process.exitCode set above is
    // preserved.
    process.exit(process.exitCode ?? 0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
