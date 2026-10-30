import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import {
  IntegrationState,
  Provider,
  PullRequestState,
  Role,
} from '../../generated/prisma/enums';
import { ScanQueueService } from '../../queue/scan-queue.service';
import { GithubAppService } from '../integrations/github-app.service';
import { GitlabApiService } from '../integrations/gitlab-api.service';
import { ProviderMergeError } from '../integrations/provider-merge-error';
import { MergePullDto, MergeResultDto } from './dto/merge-pull.dto';
import { loadMergeBlockers } from './merge-blockers';

// A credential that cannot act on the repository right now.
const UNUSABLE_STATES: IntegrationState[] = [
  IntegrationState.TOKEN_EXPIRED,
  IntegrationState.INVALID,
  IntegrationState.UNINSTALLED,
  IntegrationState.SUSPENDED,
  IntegrationState.PENDING_APPROVAL,
];

// Merging from Critiq (v1.5.2): a separate, explicit human action after an
// approval — never part of approving. Critiq's own rules (mergeBlockers)
// run first; the provider's branch protection, CI and conflicts still
// decide last.
@Injectable()
export class MergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly githubAppService: GithubAppService,
    private readonly gitlabApiService: GitlabApiService,
    private readonly scanQueue: ScanQueueService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly realtime: RealtimePublisher,
  ) {}

  async merge(
    organizationId: string,
    repositoryId: string,
    pullId: string,
    actorUserId: string,
    dto: MergePullDto,
  ): Promise<MergeResultDto> {
    const pull = await this.prisma.pullRequest.findUnique({
      where: { id: pullId },
      include: {
        latestScan: {
          select: { status: true, headSha: true, criticalCount: true },
        },
        repository: { include: { integration: true } },
      },
    });
    // Check-after-fetch: another org's PR is indistinguishable from none.
    if (
      !pull ||
      pull.organizationId !== organizationId ||
      pull.repositoryId !== repositoryId
    ) {
      throw new NotFoundException('Pull request not found.');
    }
    if (pull.state !== PullRequestState.OPEN) {
      throw new UnprocessableEntityException({
        field: 'pullId',
        message: 'pull_not_open',
        blockers: ['pull_not_open'],
      });
    }
    if (!pull.headSha || dto.headSha !== pull.headSha) {
      throw new ConflictException({
        field: 'headSha',
        message: 'head_changed',
      });
    }

    const membership = await this.prisma.membership.findUniqueOrThrow({
      where: {
        userId_organizationId: { userId: actorUserId, organizationId },
      },
      select: { role: true },
    });
    // One reading of the override for the role check, the blocker and the
    // audit: `null` (or anything falsy past validation) is no override.
    const override = dto.overrideCritical ?? undefined;
    if (override && membership.role !== Role.ADMIN) {
      throw new ForbiddenException({
        field: 'overrideCritical',
        message: 'override_requires_admin',
      });
    }

    const blockers = await loadMergeBlockers(this.prisma, pull);
    const overridden =
      override !== undefined && blockers.includes('critical_findings');
    const remaining = blockers.filter(
      (blocker) => !(overridden && blocker === 'critical_findings'),
    );
    if (remaining.length > 0) {
      throw new UnprocessableEntityException({
        field: 'pullId',
        message: remaining[0],
        blockers: remaining,
      });
    }

    const method = dto.method ?? 'merge';
    const { repository } = pull;
    const { integration } = repository;
    if (UNUSABLE_STATES.includes(integration.state)) {
      throw new ForbiddenException({
        field: 'organizationId',
        message: 'insufficient_permission',
      });
    }

    try {
      if (integration.source === Provider.GITHUB) {
        const [owner, repo] = repository.path.split('/');
        const installationId = integration.installationId ?? '';
        await this.githubAppService.mergePullRequest(
          installationId,
          owner,
          repo,
          pull.externalId,
          { sha: pull.headSha, method },
        );
        if (dto.deleteSourceBranch) {
          await this.githubAppService.deleteBranch(
            installationId,
            owner,
            repo,
            pull.sourceBranch,
          );
        }
      } else {
        await this.gitlabApiService.mergeMergeRequest(
          integration.instanceUrl ?? '',
          integration.encryptedToken
            ? this.encryptionService.decrypt(integration.encryptedToken)
            : '',
          repository.externalId,
          pull.externalId,
          {
            sha: pull.headSha,
            squash: method === 'squash',
            removeSourceBranch: dto.deleteSourceBranch === true,
          },
        );
      }
    } catch (error) {
      throw this.toHttpError(error, { organizationId, pullId });
    }

    // The provider's own `merged` webhook follows and upserts the same state.
    await this.prisma.pullRequest.updateMany({
      where: { id: pullId, state: PullRequestState.OPEN },
      data: { state: PullRequestState.MERGED },
    });
    await this.scanQueue.cancelPending(pullId);
    await this.realtime.publish({
      type: 'pull.updated',
      orgId: organizationId,
      repoId: repositoryId,
      pullId,
      state: PullRequestState.MERGED,
      headChanged: false,
    });

    // TODO(audit log model): persisted row once the table exists.
    this.logger.info('audit.pull.merged', {
      orgId: organizationId,
      repoId: repositoryId,
      pullId,
      by: actorUserId,
      role: membership.role,
      method,
      headSha: pull.headSha,
      deleteSourceBranch: dto.deleteSourceBranch === true,
      overrideCritical: overridden,
      reason: overridden ? override?.reason : undefined,
    });

    return {
      state: 'merged',
      method,
      headSha: pull.headSha,
      mergedAt: new Date(),
    };
  }

  private toHttpError(
    error: unknown,
    log: { organizationId: string; pullId: string },
  ): Error {
    if (!(error instanceof ProviderMergeError)) {
      return error as Error;
    }
    this.logger.warn('pull.merge_refused', {
      orgId: log.organizationId,
      pullId: log.pullId,
      code: error.code,
      detail: error.detail,
    });
    const body = { field: 'pullId', message: error.code };
    switch (error.code) {
      case 'head_changed':
        return new ConflictException(body);
      case 'not_mergeable':
        return new UnprocessableEntityException({
          ...body,
          detail: error.detail ?? null,
        });
      case 'insufficient_permission':
        return new ForbiddenException(body);
      default:
        return new BadGatewayException(body);
    }
  }
}
