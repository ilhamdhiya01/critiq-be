import { createHmac, timingSafeEqual } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import {
  Provider,
  PullRequestState,
  ScanTrigger,
} from '../../generated/prisma/enums';
import { ScanQueueService } from '../../queue/scan-queue.service';
import { PullsService } from '../pulls/pulls.service';
import {
  GithubPullRequestPayload,
  GitlabMergeRequestPayload,
  isGithubPingEvent,
  isGithubPullRequestPayload,
  isGitlabMergeRequestPayload,
  parseJsonBody,
} from './webhook-payload';

export type WebhookSkipReason =
  | 'malformed'
  | 'ping'
  | 'unsupported_event'
  | 'unknown_repo'
  | 'out_of_scope'
  | 'not_scan_trigger'
  | 'no_head_sha';

// What happened to a delivery — WebhooksController maps this to an HTTP
// status. Kept provider-agnostic so both handlers share one mapping.
export type WebhookOutcome =
  | { kind: 'rejected' } // could not authenticate the sender → 401
  | { kind: 'duplicate' }
  | { kind: 'skipped'; reason: WebhookSkipReason }
  | { kind: 'pull_closed' }
  | { kind: 'scan_enqueued'; scanId: string; deduplicated: boolean };

const DELIVERY_DEDUPE_TTL_SECONDS = 86_400;

// Actions after which the PR's head may point at code not yet scanned.
// Everything else (edited, labeled, assigned, approved, ...) only touches
// metadata: still upserted, but never (re)triggers a scan — otherwise a
// label change would keep re-running a scan that failed for a
// non-transient reason like diff_too_large.
const GITHUB_SCAN_ACTIONS = new Set([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
]);

interface VerifiedEvent {
  provider: Provider;
  repository: {
    id: string;
    organizationId: string;
    scanConfig: { branches: string[] } | null;
  };
  deliveryId: string | undefined;
  targetBranch: string | undefined;
  payload: GitlabMergeRequestPayload | GithubPullRequestPayload;
  isScanTrigger: boolean;
  baseSha: string | null;
}

// Webhook = verify, resolve, upsert, enqueue — nothing slower. No provider
// API call ever happens inside the request (diffs are fetched by the
// worker), which is what keeps the handler well under the 300 ms budget.
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    private readonly pullsService: PullsService,
    private readonly scanQueueService: ScanQueueService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async handleGitlabEvent(
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<WebhookOutcome> {
    const parsed = parseJsonBody(rawBody);
    if (!isGitlabMergeRequestPayload(parsed)) {
      this.logger.warn('webhook.gitlab.rejected', {
        reason: 'malformed_payload',
      });
      return { kind: 'skipped', reason: 'malformed' };
    }
    const payload = parsed;

    const repository = await this.prisma.repository.findFirst({
      where: {
        provider: Provider.GITLAB,
        externalId: String(payload.project.id),
      },
      include: { scanConfig: true },
    });

    // GitLab's secret is per-repo, so an unknown repo (or one whose secret
    // was never stored) means the delivery cannot be authenticated at all —
    // answered exactly like a wrong token. Returning 200 here instead would
    // let an unauthenticated caller enumerate which project ids are
    // connected (401 vs 200), and a hook left behind on a disconnected repo
    // then gets auto-disabled by GitLab, which is the desired outcome.
    if (!repository?.encryptedWebhookSecret) {
      this.logger.warn('webhook.gitlab.rejected', {
        reason: repository ? 'no_secret_configured' : 'unknown_repo',
        projectId: payload.project.id,
      });
      return { kind: 'rejected' };
    }

    const expectedSecret = this.encryptionService.decrypt(
      repository.encryptedWebhookSecret,
    );
    const providedToken = headers['x-gitlab-token'];
    if (
      typeof providedToken !== 'string' ||
      !this.safeCompare(providedToken, expectedSecret)
    ) {
      this.logger.warn('webhook.gitlab.rejected', {
        repositoryId: repository.id,
        reason: 'token_mismatch',
      });
      return { kind: 'rejected' };
    }

    if (payload.object_kind !== 'merge_request') {
      this.logger.info('webhook.gitlab.ignored_event', {
        repositoryId: repository.id,
        objectKind: payload.object_kind,
      });
      return { kind: 'skipped', reason: 'unsupported_event' };
    }

    const attrs = payload.object_attributes;
    const action = attrs?.action;
    return this.processVerifiedEvent({
      provider: Provider.GITLAB,
      repository,
      deliveryId: this.headerString(headers, 'x-gitlab-event-uuid'),
      targetBranch: attrs?.target_branch,
      payload,
      // `update` fires for title/description/label edits too; only an
      // update carrying `oldrev` means new commits were pushed. A missing
      // action (older GitLab) falls through to scanning — the sha-level
      // dedupe in ScanQueueService makes that safe.
      isScanTrigger:
        action === undefined ||
        action === 'open' ||
        action === 'reopen' ||
        (action === 'update' && attrs?.oldrev !== undefined),
      // GitLab MR webhooks carry no reliable merge-base sha (`oldrev` is the
      // previous head, not the base). baseSha is informational only — the
      // worker fetches the diff by MR iid — so null beats a wrong value.
      baseSha: null,
    });
  }

  async handleGithubEvent(
    rawBody: Buffer,
    headers: Record<string, unknown>,
  ): Promise<WebhookOutcome> {
    const signatureHeader = headers['x-hub-signature-256'];
    const secret = this.configService.getOrThrow<string>(
      'githubApp.webhookSecret',
    );
    const expectedSignature =
      'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

    // Checked before anything else, including delivery-id dedupe, so a
    // forged delivery id can never poison the dedupe cache.
    if (
      typeof signatureHeader !== 'string' ||
      !this.safeCompare(signatureHeader, expectedSignature)
    ) {
      this.logger.warn('webhook.github.rejected', { reason: 'bad_signature' });
      return { kind: 'rejected' };
    }

    const parsed = parseJsonBody(rawBody);

    // Sent once when the webhook is first saved in the App settings, to
    // confirm the endpoint is reachable. Carries no repository, so there is
    // nothing to resolve or scan — acknowledged and dropped.
    if (isGithubPingEvent(parsed)) {
      this.logger.info('webhook.github.ping');
      return { kind: 'skipped', reason: 'ping' };
    }

    // pull_request_review / pull_request_review_comment payloads also carry
    // a full `pull_request` object and would pass the shape guard below.
    const eventName = this.headerString(headers, 'x-github-event');
    if (eventName !== undefined && eventName !== 'pull_request') {
      this.logger.info('webhook.github.ignored_event', { eventName });
      return { kind: 'skipped', reason: 'unsupported_event' };
    }

    if (!isGithubPullRequestPayload(parsed)) {
      this.logger.warn('webhook.github.rejected', {
        reason: 'malformed_payload',
      });
      return { kind: 'skipped', reason: 'malformed' };
    }
    const payload = parsed;

    const repository = await this.prisma.repository.findFirst({
      where: {
        provider: Provider.GITHUB,
        externalId: String(payload.repository.id),
      },
      include: { scanConfig: true },
    });
    // Unlike GitLab, the signature above already proves GitHub sent this:
    // one App installation covers repos the org never connected to Critiq,
    // so an unknown repo is a normal, authenticated delivery → 200.
    if (!repository) {
      this.logger.info('webhook.github.unknown_repo', {
        repoId: payload.repository.id,
      });
      return { kind: 'skipped', reason: 'unknown_repo' };
    }

    return this.processVerifiedEvent({
      provider: Provider.GITHUB,
      repository,
      deliveryId: this.headerString(headers, 'x-github-delivery'),
      targetBranch: payload.pull_request?.base.ref,
      payload,
      isScanTrigger:
        payload.action === undefined || GITHUB_SCAN_ACTIONS.has(payload.action),
      baseSha: payload.pull_request?.base.sha ?? null,
    });
  }

  // Everything after the sender is authenticated and the repo resolved —
  // identical for both providers.
  private async processVerifiedEvent(
    event: VerifiedEvent,
  ): Promise<WebhookOutcome> {
    const { provider, repository, targetBranch } = event;
    const logContext = {
      provider,
      orgId: repository.organizationId,
      repoId: repository.id,
    };

    const dedupeKey = event.deliveryId
      ? `webhook:delivery:${provider}:${event.deliveryId}`
      : null;
    if (dedupeKey && !(await this.claimDelivery(dedupeKey))) {
      this.logger.info('webhook.duplicate_delivery', {
        ...logContext,
        deliveryId: event.deliveryId,
      });
      return { kind: 'duplicate' };
    }

    try {
      if (!targetBranch || !repository.scanConfig) {
        return { kind: 'skipped', reason: 'unsupported_event' };
      }
      if (!repository.scanConfig.branches.includes(targetBranch)) {
        this.logger.info('scan.skipped_out_of_scope', {
          ...logContext,
          targetBranch,
        });
        return { kind: 'skipped', reason: 'out_of_scope' };
      }

      const pull = await this.pullsService.upsertFromWebhook(
        repository.organizationId,
        repository.id,
        provider,
        event.payload,
      );
      if (!pull) {
        return { kind: 'skipped', reason: 'malformed' };
      }

      // Closed/merged: stop spending compute on a PR nobody will review.
      if (pull.state !== PullRequestState.OPEN) {
        const superseded = await this.scanQueueService.cancelPending(pull.id);
        this.logger.info('webhook.pull_closed', {
          ...logContext,
          pullId: pull.id,
          state: pull.state,
          superseded,
        });
        return { kind: 'pull_closed' };
      }

      if (!event.isScanTrigger) {
        return { kind: 'skipped', reason: 'not_scan_trigger' };
      }
      if (!pull.headSha) {
        this.logger.warn('webhook.no_head_sha', {
          ...logContext,
          pullId: pull.id,
        });
        return { kind: 'skipped', reason: 'no_head_sha' };
      }

      const result = await this.scanQueueService.enqueue({
        organizationId: repository.organizationId,
        repositoryId: repository.id,
        pullId: pull.id,
        headSha: pull.headSha,
        baseSha: event.baseSha,
        provider,
        trigger: ScanTrigger.WEBHOOK,
      });
      return {
        kind: 'scan_enqueued',
        scanId: result.scanId,
        deduplicated: result.deduplicated,
      };
    } catch (error) {
      // Release the claim so a redelivery of this same event (manual
      // "Redeliver" on GitHub, GitLab's retry) can be processed instead of
      // being swallowed as a duplicate of an attempt that never finished.
      if (dedupeKey) {
        await this.redis.del(dedupeKey).catch(() => undefined);
      }
      throw error;
    }
  }

  // SET NX EX: true when this is the first time the delivery is seen.
  // Fails open — if Redis is unreachable the event is still processed;
  // the Scan table's per-sha dedupe keeps a double delivery harmless.
  private async claimDelivery(key: string): Promise<boolean> {
    try {
      const result = await this.redis.set(
        key,
        '1',
        'EX',
        DELIVERY_DEDUPE_TTL_SECONDS,
        'NX',
      );
      return result === 'OK';
    } catch (error) {
      this.logger.warn('webhook.delivery_dedupe_unavailable', {
        errorName: error instanceof Error ? error.name : 'Unknown',
      });
      return true;
    }
  }

  private headerString(
    headers: Record<string, unknown>,
    name: string,
  ): string | undefined {
    const value = headers[name];
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  // Constant-time comparison — a naive `===` on secrets leaks timing
  // information an attacker could use to guess the secret byte-by-byte.
  // Length is compared first since timingSafeEqual throws (not returns
  // false) on mismatched buffer lengths.
  private safeCompare(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) {
      return false;
    }
    return timingSafeEqual(bufferA, bufferB);
  }
}
