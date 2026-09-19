import { createHmac, timingSafeEqual } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { Provider } from '../../generated/prisma/enums';
import {
  isGithubPingEvent,
  isGithubPullRequestPayload,
  isGitlabMergeRequestPayload,
  parseJsonBody,
} from './webhook-payload';

// Scope of this service is deliberately narrow (see the webhook rollout
// plan): verify signature, resolve the repo, check D6's scan scope, and
// log the outcome. No BullMQ/queue infra exists yet, so nothing is
// enqueued here — this is the "receive and log" half only, the "act on it"
// half is Fase 4 proper.
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async handleGitlabEvent(rawBody: Buffer, headers: Record<string, unknown>) {
    const parsed = parseJsonBody(rawBody);
    if (!isGitlabMergeRequestPayload(parsed)) {
      this.logger.warn('webhook.gitlab.rejected', {
        reason: 'malformed_payload',
      });
      return;
    }
    const payload = parsed;

    const repository = await this.prisma.repository.findFirst({
      where: {
        provider: Provider.GITLAB,
        externalId: String(payload.project.id),
      },
      include: { scanConfig: true },
    });
    if (!repository) {
      this.logger.warn('webhook.gitlab.unknown_repo', {
        projectId: payload.project.id,
      });
      return;
    }

    if (!repository.encryptedWebhookSecret) {
      this.logger.warn('webhook.gitlab.no_secret_configured', {
        repositoryId: repository.id,
      });
      return;
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
      return;
    }

    if (payload.object_kind !== 'merge_request') {
      this.logger.info('webhook.gitlab.ignored_event', {
        repositoryId: repository.id,
        objectKind: payload.object_kind,
      });
      return;
    }

    const targetBranch = payload.object_attributes?.target_branch;
    const scanConfig = repository.scanConfig;
    if (!targetBranch || !scanConfig) {
      this.logger.warn('webhook.gitlab.missing_target_branch', {
        repositoryId: repository.id,
      });
      return;
    }

    if (!scanConfig.branches.includes(targetBranch)) {
      this.logger.info('scan.skipped_out_of_scope', {
        repositoryId: repository.id,
        targetBranch,
      });
      return;
    }

    // TODO Fase 4: enqueue a scan job (BullMQ) here instead of just
    // logging — queue infra doesn't exist yet.
    this.logger.info('webhook.gitlab.received_in_scope', {
      repositoryId: repository.id,
      targetBranch,
    });
  }

  async handleGithubEvent(rawBody: Buffer, headers: Record<string, unknown>) {
    const signatureHeader = headers['x-hub-signature-256'];
    const secret = this.configService.getOrThrow<string>(
      'githubApp.webhookSecret',
    );
    const expectedSignature =
      'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

    if (
      typeof signatureHeader !== 'string' ||
      !this.safeCompare(signatureHeader, expectedSignature)
    ) {
      this.logger.warn('webhook.github.rejected', { reason: 'bad_signature' });
      return;
    }

    const parsed = parseJsonBody(rawBody);

    // Sent once when the webhook is first saved in the App settings, to
    // confirm the endpoint is reachable. Carries no repository, so there is
    // nothing to resolve or scan — acknowledged and dropped.
    if (isGithubPingEvent(parsed)) {
      this.logger.info('webhook.github.ping');
      return;
    }

    if (!isGithubPullRequestPayload(parsed)) {
      this.logger.warn('webhook.github.rejected', {
        reason: 'malformed_payload',
      });
      return;
    }
    const payload = parsed;

    const repository = await this.prisma.repository.findFirst({
      where: {
        provider: Provider.GITHUB,
        externalId: String(payload.repository.id),
      },
      include: { scanConfig: true },
    });
    if (!repository) {
      this.logger.warn('webhook.github.unknown_repo', {
        repoId: payload.repository.id,
      });
      return;
    }

    const targetBranch = payload.pull_request?.base.ref;
    const scanConfig = repository.scanConfig;
    if (!targetBranch || !scanConfig) {
      this.logger.info('webhook.github.ignored_event', {
        repositoryId: repository.id,
      });
      return;
    }

    if (!scanConfig.branches.includes(targetBranch)) {
      this.logger.info('scan.skipped_out_of_scope', {
        repositoryId: repository.id,
        targetBranch,
      });
      return;
    }

    // TODO Fase 4: enqueue a scan job (BullMQ) here instead of just
    // logging — queue infra doesn't exist yet.
    this.logger.info('webhook.github.received_in_scope', {
      repositoryId: repository.id,
      targetBranch,
    });
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
