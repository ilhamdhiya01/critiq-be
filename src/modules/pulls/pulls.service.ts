import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import {
  IntegrationState,
  Provider,
  PullRequestState,
  ReviewPolicy,
} from '../../generated/prisma/enums';
import type {
  GithubPullRequestPayload,
  GitlabMergeRequestPayload,
} from '../webhooks/webhook-payload';
import {
  GithubAppService,
  GithubPullRequestFile,
} from '../integrations/github-app.service';
import {
  GitlabApiService,
  GitlabMergeRequestDiff,
} from '../integrations/gitlab-api.service';
import { PullRequestListItemDto } from './dto/pull-request-list-item.dto';
import { PullRequestOrgListItemDto } from './dto/pull-request-org-list-item.dto';
import { PullRequestDetailDto } from './dto/pull-request-detail.dto';
import {
  PullRequestDiffDto,
  PullRequestFileDto,
} from './dto/pull-request-diff.dto';

interface MappedPullRequest {
  externalId: string;
  title: string;
  authorUsername: string | null;
  sourceBranch: string;
  targetBranch: string;
  headSha: string | null;
  state: PullRequestState;
}

@Injectable()
export class PullsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly githubAppService: GithubAppService,
    private readonly gitlabApiService: GitlabApiService,
    private readonly encryptionService: EncryptionService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  // Called synchronously from WebhooksService at the point an in-scope
  // MR/PR event is received — no queue involved (BullMQ doesn't exist yet,
  // Fase 4). Repeated events for the same PR (opened, then synchronize,
  // then closed) upsert the same row rather than creating duplicates.
  async upsertFromWebhook(
    organizationId: string,
    repositoryId: string,
    provider: Provider,
    payload: GitlabMergeRequestPayload | GithubPullRequestPayload,
  ): Promise<void> {
    const mapped =
      provider === Provider.GITLAB
        ? this.mapGitlabPayload(payload as GitlabMergeRequestPayload)
        : this.mapGithubPayload(payload as GithubPullRequestPayload);
    if (!mapped) {
      return;
    }

    const effectivePolicy = await this.resolveEffectivePolicy(
      repositoryId,
      mapped.targetBranch,
    );

    await this.prisma.pullRequest.upsert({
      where: {
        repositoryId_externalId: {
          repositoryId,
          externalId: mapped.externalId,
        },
      },
      create: {
        organizationId,
        repositoryId,
        provider,
        externalId: mapped.externalId,
        title: mapped.title,
        authorUsername: mapped.authorUsername,
        sourceBranch: mapped.sourceBranch,
        targetBranch: mapped.targetBranch,
        headSha: mapped.headSha,
        state: mapped.state,
        effectivePolicy,
      },
      // effectivePolicy is deliberately omitted here — it's a snapshot
      // taken once at creation (CLAUDE.md "Prioritas policy": branch
      // policy changes must not retroactively change what an already-open
      // PR shows), never re-derived on later events for the same PR.
      update: {
        title: mapped.title,
        authorUsername: mapped.authorUsername,
        sourceBranch: mapped.sourceBranch,
        headSha: mapped.headSha,
        state: mapped.state,
      },
    });
  }

  async list(
    organizationId: string,
    repositoryId: string,
  ): Promise<PullRequestListItemDto[]> {
    await this.assertRepositoryInOrg(organizationId, repositoryId);
    const pulls = await this.prisma.pullRequest.findMany({
      where: { repositoryId },
      orderBy: { updatedAt: 'desc' },
    });
    return pulls.map(
      (pull) =>
        new PullRequestListItemDto({
          id: pull.id,
          provider: pull.provider,
          externalId: pull.externalId,
          title: pull.title,
          authorUsername: pull.authorUsername,
          sourceBranch: pull.sourceBranch,
          targetBranch: pull.targetBranch,
          state: pull.state,
          effectivePolicy: pull.effectivePolicy,
          createdAt: pull.createdAt,
          updatedAt: pull.updatedAt,
        }),
    );
  }

  // Org-wide dashboard view (e.g. a single "Pull Requests" page listing PRs
  // across every connected repo) — still scoped strictly by organizationId,
  // same tenancy guarantee as the per-repo list. Kept as a separate method/
  // DTO rather than an optional param on list(): the two have different
  // guard requirements at the controller (this one has no :repoId to
  // resolve) and a different response shape (repository identifiers
  // included here, since results span repos).
  async listForOrganization(
    organizationId: string,
  ): Promise<PullRequestOrgListItemDto[]> {
    const pulls = await this.prisma.pullRequest.findMany({
      where: { organizationId },
      include: { repository: { select: { path: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    return pulls.map(
      (pull) =>
        new PullRequestOrgListItemDto({
          id: pull.id,
          repositoryId: pull.repositoryId,
          repositoryPath: pull.repository.path,
          provider: pull.provider,
          externalId: pull.externalId,
          title: pull.title,
          authorUsername: pull.authorUsername,
          sourceBranch: pull.sourceBranch,
          targetBranch: pull.targetBranch,
          state: pull.state,
          effectivePolicy: pull.effectivePolicy,
          createdAt: pull.createdAt,
          updatedAt: pull.updatedAt,
        }),
    );
  }

  async getDetail(
    organizationId: string,
    repositoryId: string,
    pullRequestId: string,
  ): Promise<PullRequestDetailDto> {
    const pull = await this.prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
    });
    // Checked against the row, not filtered in `where` — a PR that exists
    // but belongs to another org/repo surfaces identically to one that
    // doesn't exist at all (D5 tenancy — never leak existence).
    if (
      !pull ||
      pull.organizationId !== organizationId ||
      pull.repositoryId !== repositoryId
    ) {
      throw new NotFoundException('Pull request not found.');
    }

    return new PullRequestDetailDto({
      id: pull.id,
      repositoryId: pull.repositoryId,
      provider: pull.provider,
      externalId: pull.externalId,
      title: pull.title,
      authorUsername: pull.authorUsername,
      sourceBranch: pull.sourceBranch,
      targetBranch: pull.targetBranch,
      headSha: pull.headSha,
      state: pull.state,
      effectivePolicy: pull.effectivePolicy,
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
    });
  }

  // Live-proxied from the provider on every call — same convention as
  // ReposService.getBranchesForRepo (branches). No diff/file data is ever
  // stored in the DB; this only reads PullRequest for its provider
  // identifiers, then calls out.
  async getDiff(
    organizationId: string,
    repositoryId: string,
    pullRequestId: string,
  ): Promise<PullRequestDiffDto> {
    const pull = await this.prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
      include: { repository: { include: { integration: true } } },
    });
    if (
      !pull ||
      pull.organizationId !== organizationId ||
      pull.repositoryId !== repositoryId
    ) {
      throw new NotFoundException('Pull request not found.');
    }

    const { repository } = pull;
    const { integration } = repository;
    if (
      integration.state === IntegrationState.TOKEN_EXPIRED ||
      integration.state === IntegrationState.INVALID
    ) {
      throw new ConflictException({
        field: 'organizationId',
        message:
          integration.state === IntegrationState.TOKEN_EXPIRED
            ? 'token_expired'
            : 'token_invalid',
      });
    }

    if (integration.source === Provider.GITHUB) {
      if (!integration.installationId) {
        throw new Error(
          'Integration row with source GITHUB is missing installationId — data invariant violated.',
        );
      }
      const [owner, repo] = repository.path.split('/');
      const result = await this.githubAppService.listPullRequestFiles(
        integration.installationId,
        owner,
        repo,
        pull.externalId,
      );
      return new PullRequestDiffDto({
        files: result.files.map((file) => this.mapGithubFile(file)),
        truncated: result.truncated,
      });
    }

    if (!integration.instanceUrl || !integration.encryptedToken) {
      throw new Error(
        'Integration row with source GITLAB is missing its GitLab credential fields — data invariant violated.',
      );
    }
    const token = this.encryptionService.decrypt(integration.encryptedToken);
    const result = await this.gitlabApiService.fetchMergeRequestDiffs(
      integration.instanceUrl,
      token,
      repository.externalId,
      pull.externalId,
    );
    return new PullRequestDiffDto({
      files: result.diffs.map((diff) => this.mapGitlabDiff(diff)),
      truncated: result.truncated,
    });
  }

  private mapGithubFile(file: GithubPullRequestFile): PullRequestFileDto {
    const truncated = file.patch === undefined;
    const status =
      file.status === 'added' ||
      file.status === 'removed' ||
      file.status === 'renamed'
        ? file.status
        : 'modified';
    return new PullRequestFileDto({
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
      truncated,
    });
  }

  private mapGitlabDiff(diff: GitlabMergeRequestDiff): PullRequestFileDto {
    const truncated = diff.diff === '';
    const status = diff.new_file
      ? 'added'
      : diff.deleted_file
        ? 'removed'
        : diff.renamed_file
          ? 'renamed'
          : 'modified';
    return new PullRequestFileDto({
      path: diff.new_path,
      previousPath: diff.renamed_file ? diff.old_path : null,
      status,
      additions: null,
      deletions: null,
      patch: truncated ? null : diff.diff,
      truncated,
    });
  }

  private async assertRepositoryInOrg(
    organizationId: string,
    repositoryId: string,
  ): Promise<void> {
    const repository = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { organizationId: true },
    });
    if (!repository || repository.organizationId !== organizationId) {
      throw new NotFoundException('Repository not found.');
    }
  }

  private async resolveEffectivePolicy(
    repositoryId: string,
    targetBranch: string,
  ): Promise<ReviewPolicy> {
    const policy = await this.prisma.branchScanPolicy.findUnique({
      where: { repositoryId_branch: { repositoryId, branch: targetBranch } },
    });
    if (!policy) {
      // Defensive fallback only — ReposService.createRepos always creates
      // a BranchScanPolicy row for every monitored branch in the same
      // transaction, so this should not happen in the normal flow.
      this.logger.warn('pulls.effective_policy_fallback', {
        repositoryId,
        targetBranch,
      });
      return ReviewPolicy.MANUAL_ONLY;
    }
    return policy.policy;
  }

  private mapGitlabPayload(
    payload: GitlabMergeRequestPayload,
  ): MappedPullRequest | null {
    const attrs = payload.object_attributes;
    if (!attrs) {
      return null;
    }
    return {
      externalId: String(attrs.iid),
      title: attrs.title,
      authorUsername: payload.user?.username ?? null,
      sourceBranch: attrs.source_branch,
      targetBranch: attrs.target_branch,
      headSha: attrs.last_commit?.id ?? null,
      state: this.mapGitlabState(attrs.state),
    };
  }

  private mapGithubPayload(
    payload: GithubPullRequestPayload,
  ): MappedPullRequest | null {
    const pr = payload.pull_request;
    if (!pr) {
      return null;
    }
    return {
      externalId: String(pr.number),
      title: pr.title,
      authorUsername: pr.user?.login ?? null,
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      headSha: pr.head.sha ?? null,
      state: this.mapGithubState(pr.state, pr.merged),
    };
  }

  // `locked` maps to OPEN — locking only blocks new discussion on the MR,
  // it isn't a terminal PR status (a locked MR is typically mid-merge).
  private mapGitlabState(state: string): PullRequestState {
    switch (state) {
      case 'merged':
        return PullRequestState.MERGED;
      case 'closed':
        return PullRequestState.CLOSED;
      default:
        return PullRequestState.OPEN;
    }
  }

  private mapGithubState(state: string, merged: boolean): PullRequestState {
    if (state === 'closed') {
      return merged ? PullRequestState.MERGED : PullRequestState.CLOSED;
    }
    return PullRequestState.OPEN;
  }
}
