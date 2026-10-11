import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { CommonModule } from '../common/common.module';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { Provider } from '../generated/prisma/enums';
import { GitlabApiService } from '../modules/integrations/gitlab-api.service';

// One-off: turns on pipeline events for GitLab hooks created before the
// Failing CI tier existed. New hooks get them from createProjectHook. Safe
// to run twice — the edit just sets the same flags again.
//
//   pnpm gitlab:pipeline-events
@Module({
  imports: [CommonModule, HttpModule],
  providers: [GitlabApiService],
})
class EnablePipelineEventsModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(
    EnablePipelineEventsModule,
    { logger: ['error', 'warn'] },
  );
  try {
    const prisma = app.get(PrismaService);
    const encryption = app.get(EncryptionService);
    const gitlab = app.get(GitlabApiService);
    const url = `${app.get(ConfigService).getOrThrow<string>('backendUrl')}/api/v1/webhooks/gitlab`;

    const repositories = await prisma.repository.findMany({
      where: { provider: Provider.GITLAB, gitlabWebhookId: { not: null } },
      select: {
        id: true,
        path: true,
        externalId: true,
        gitlabWebhookId: true,
        integration: { select: { instanceUrl: true, encryptedToken: true } },
      },
    });
    let updated = 0;
    for (const repository of repositories) {
      const { instanceUrl, encryptedToken } = repository.integration;
      if (
        !instanceUrl ||
        !encryptedToken ||
        repository.gitlabWebhookId === null
      ) {
        console.warn(`skip ${repository.path}: no GitLab credential`);
        continue;
      }
      try {
        await gitlab.enablePipelineEvents(
          instanceUrl,
          encryption.decrypt(encryptedToken),
          repository.externalId,
          repository.gitlabWebhookId,
          url,
        );
        updated += 1;
        console.log(`ok   ${repository.path}`);
      } catch (error) {
        console.error(
          `fail ${repository.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }
    }
    console.log(`\n${updated} of ${repositories.length} hook(s) updated.`);
  } finally {
    await app.close();
  }
}

void main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
