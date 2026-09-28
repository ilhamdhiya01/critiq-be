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
  FindingSeverity,
  FindingSource,
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
import { ScanSummaryDto } from './dto/scan-summary.dto';
import {
  DiffAnnotations,
  PullRequestDiffDto,
  PullRequestFileDto,
} from './dto/pull-request-diff.dto';
import { FindingDto } from '../scans/dto/finding.dto';
import { LatestScanDto } from '../scans/dto/scan.dto';
import {
  AI_SCAN_FIELDS_SELECT,
  AiScanFieldsRow,
  toApiAiScanFields,
} from '../scans/dto/ai-scan-fields';
import { ScansService } from '../scans/scans.service';

// What PR lists show of the latest scan — selected, not included, so a list
// never drags each scan's full row along.
const LATEST_SCAN_LIST_SELECT = {
  id: true,
  status: true,
  criticalCount: true,
  suppressedCount: true,
  finishedAt: true,
  ...AI_SCAN_FIELDS_SELECT,
} as const;

const HEAD_FILE_FETCH_CONCURRENCY = 5;
// Larger files are skipped for AI context: generated or vendored content,
// and too big to be worth the tokens around a small hunk.
const MAX_HEAD_FILE_CHARS = 512 * 1024;

export interface UpsertedPullRequest {
  id: string;
  state: PullRequestState;
  headSha: string | null;
}

interface MappedPullRequest {
  externalId: string;
  title: string;
  description: string | null;
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
    private readonly scansService: ScansService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  // Called from WebhooksService when an in-scope MR/PR event is received,
  // before it enqueues (or cancels) a scan — pure DB write, never a
  // provider call, so the webhook request stays fast. Repeated events for
  // the same PR (opened, then synchronize, then closed) upsert the same row
  // rather than creating duplicates.
  async upsertFromWebhook(
    organizationId: string,
    repositoryId: string,
    provider: Provider,
    payload: GitlabMergeRequestPayload | GithubPullRequestPayload,
  ): Promise<UpsertedPullRequest | null> {
    const mapped =
      provider === Provider.GITLAB
        ? this.mapGitlabPayload(payload as GitlabMergeRequestPayload)
        : this.mapGithubPayload(payload as GithubPullRequestPayload);
    if (!mapped) {
      return null;
    }

    const effectivePolicy = await this.resolveEffectivePolicy(
      repositoryId,
      mapped.targetBranch,
    );

    return this.prisma.pullRequest.upsert({
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
        description: mapped.description,
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
        description: mapped.description,
        authorUsername: mapped.authorUsername,
        sourceBranch: mapped.sourceBranch,
        headSha: mapped.headSha,
        state: mapped.state,
      },
      select: { id: true, state: true, headSha: true },
    });
  }

  async list(
    organizationId: string,
    repositoryId: string,
  ): Promise<PullRequestListItemDto[]> {
    await this.assertRepositoryInOrg(organizationId, repositoryId);
    const pulls = await this.prisma.pullRequest.findMany({
      where: { repositoryId },
      include: { latestScan: { select: LATEST_SCAN_LIST_SELECT } },
      orderBy: { updatedAt: 'desc' },
    });
    const activeScans = await this.scansService.findActiveScans(
      pulls.map((pull) => pull.id),
    );
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
          latestScan: this.toLatestScanDto(pull.latestScan),
          activeScan: activeScans.get(pull.id) ?? null,
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
      include: {
        repository: { select: { path: true } },
        // `latestScan`, not `scans`: the latter returns every attempt ever
        // made for this PR (QUEUED, FAILED, SUPERSEDED included), while this
        // pointer is only moved on a terminal transition — so the list shows
        // the last valid result and never a count from an in-flight or
        // discarded scan. See PullRequest.latestScanId in schema.prisma.
        latestScan: { select: LATEST_SCAN_LIST_SELECT },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const activeScans = await this.scansService.findActiveScans(
      pulls.map((pull) => pull.id),
    );
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
          // 0 when the PR has never completed a scan (just opened, or every
          // attempt so far failed) — the list reads as "no criticals", which
          // is the right default here. Whether a scan ran at all is a
          // separate signal, not folded into this count.
          criticalCount: pull.latestScan?.criticalCount ?? 0,
          effectivePolicy: pull.effectivePolicy,
          latestScan: this.toLatestScanDto(pull.latestScan),
          activeScan: activeScans.get(pull.id) ?? null,
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
      include: {
        repository: { select: { path: true } },
        // `latestScan`, not `scans`: the latter is every attempt ever made
        // for this PR (FAILED and SUPERSEDED included). This pointer only
        // moves on a terminal transition, so the review page shows one
        // complete result instead of a list the caller has to pick from.
        latestScan: {
          include: {
            // Severity is an enum ordered CRITICAL -> INFO in the schema, so
            // ascending sort puts criticals first, matching how the review
            // page lists them. File path and line break ties, so the order
            // is stable between requests.
            // Active only — suppressed findings are fetched separately
            // (GET …/scans/:scanId/findings), never mixed into the list the
            // reviewer acts on.
            findings: {
              where: { suppressedReason: null },
              orderBy: [
                { severity: 'asc' },
                { filePath: 'asc' },
                { lineStart: 'asc' },
              ],
            },
          },
        },
      },
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
      repositoryPath: pull.repository.path,
      authorUsername: pull.authorUsername,
      sourceBranch: pull.sourceBranch,
      targetBranch: pull.targetBranch,
      headSha: pull.headSha,
      state: pull.state,
      effectivePolicy: pull.effectivePolicy,
      latestScan: pull.latestScan
        ? new ScanSummaryDto({
            ...toApiAiScanFields(pull.latestScan),
            id: pull.latestScan.id,
            status: pull.latestScan.status,
            trigger: pull.latestScan.trigger,
            attempt: pull.latestScan.attempt,
            headSha: pull.latestScan.headSha,
            findingsCount: pull.latestScan.findingsCount,
            criticalCount: pull.latestScan.criticalCount,
            findingsTruncated: pull.latestScan.findingsTruncated,
            suppressedCount: pull.latestScan.suppressedCount,
            suppressedTruncated: pull.latestScan.suppressedTruncated,
            filesChanged: pull.latestScan.filesChanged,
            diffBytes: pull.latestScan.diffBytes,
            rulesetVersion: pull.latestScan.rulesetVersion,
            errorMessage: pull.latestScan.errorMessage,
            startedAt: pull.latestScan.startedAt,
            finishedAt: pull.latestScan.finishedAt,
            findings: pull.latestScan.findings.map(
              (finding) =>
                new FindingDto({
                  id: finding.id,
                  source: finding.source,
                  ruleId: finding.ruleId,
                  severity: finding.severity,
                  title: finding.title,
                  message: finding.message,
                  filePath: finding.filePath,
                  lineStart: finding.lineStart,
                  lineEnd: finding.lineEnd,
                  snippet: finding.snippet,
                  suppressedReason: finding.suppressedReason,
                  category: finding.category,
                  confidence: finding.confidence,
                }),
            ),
          })
        : null,
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
    const pull = await this.loadPullWithAccess(
      organizationId,
      repositoryId,
      pullRequestId,
    );
    const { repository } = pull;
    const { integration } = repository;

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
        ...(await this.buildAnnotations(pull.latestScan)),
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
      ...(await this.buildAnnotations(pull.latestScan)),
    });
  }

  // Files at `sha`, for the AI review's head-file context (v1.5.1
  // langkah 2). Best effort per file: a failed or oversized fetch is null and
  // the prompt falls back to hunk context. Fetched a few at a time so a
  // large PR does not open dozens of provider requests at once.
  async getHeadFileContents(
    organizationId: string,
    repositoryId: string,
    pullRequestId: string,
    sha: string,
    paths: string[],
  ): Promise<Map<string, string | null>> {
    const pull = await this.loadPullWithAccess(
      organizationId,
      repositoryId,
      pullRequestId,
    );
    const { repository } = pull;
    const { integration } = repository;
    const fetchOne: (path: string) => Promise<string | null> =
      integration.source === Provider.GITHUB
        ? (path) => {
            const [owner, repo] = repository.path.split('/');
            return this.githubAppService.getFileContent(
              integration.installationId ?? '',
              owner,
              repo,
              path,
              sha,
            );
          }
        : (() => {
            const token = integration.encryptedToken
              ? this.encryptionService.decrypt(integration.encryptedToken)
              : '';
            return (path: string) =>
              this.gitlabApiService.fetchRawFile(
                integration.instanceUrl ?? '',
                token,
                repository.externalId,
                path,
                sha,
              );
          })();

    const contents = new Map<string, string | null>();
    for (let i = 0; i < paths.length; i += HEAD_FILE_FETCH_CONCURRENCY) {
      const batch = paths.slice(i, i + HEAD_FILE_FETCH_CONCURRENCY);
      const results = await Promise.all(batch.map(fetchOne));
      batch.forEach((path, index) => {
        const content = results[index];
        contents.set(
          path,
          content !== null && content.length <= MAX_HEAD_FILE_CHARS
            ? content
            : null,
        );
      });
    }
    return contents;
  }

  // The PR with its repository and integration, tenant-checked (404 across
  // orgs/repos) and refusing a dead credential — shared by the diff and
  // head-file fetches so both resolve access the same way.
  private async loadPullWithAccess(
    organizationId: string,
    repositoryId: string,
    pullRequestId: string,
  ) {
    const pull = await this.prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
      include: {
        repository: { include: { integration: true } },
        latestScan: { select: { id: true, headSha: true } },
      },
    });
    if (
      !pull ||
      pull.organizationId !== organizationId ||
      pull.repositoryId !== repositoryId
    ) {
      throw new NotFoundException('Pull request not found.');
    }
    const { integration } = pull.repository;
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
    return pull;
  }

  // Read after the provider call on purpose: a failed diff fetch shouldn't
  // have cost a findings query.
  private async buildAnnotations(
    latestScan: { id: string; headSha: string } | null,
  ): Promise<{
    annotations: DiffAnnotations;
    suppressedAnnotations: DiffAnnotations;
    annotationsScanId: string | null;
    annotationsHeadSha: string | null;
  }> {
    const annotations: DiffAnnotations = {};
    const suppressedAnnotations: DiffAnnotations = {};
    if (!latestScan) {
      return {
        annotations,
        suppressedAnnotations,
        annotationsScanId: null,
        annotationsHeadSha: null,
      };
    }

    const findings = await this.prisma.finding.findMany({
      where: { scanId: latestScan.id },
      select: {
        id: true,
        filePath: true,
        lineStart: true,
        lineEnd: true,
        severity: true,
        source: true,
        suppressedReason: true,
      },
      orderBy: [{ filePath: 'asc' }, { lineStart: 'asc' }],
    });
    for (const finding of findings) {
      // AI minor findings are listed, never marked on the diff — too noisy
      // for the line gutter (v1.5.1 langkah 2).
      if (
        finding.source === FindingSource.AI &&
        finding.severity !== FindingSeverity.CRITICAL &&
        finding.severity !== FindingSeverity.MAJOR
      ) {
        continue;
      }
      const target =
        finding.suppressedReason === null ? annotations : suppressedAnnotations;
      (target[finding.filePath] ??= []).push({
        findingId: finding.id,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
        severity: finding.severity,
        source: finding.source,
      });
    }
    return {
      annotations,
      suppressedAnnotations,
      annotationsScanId: latestScan.id,
      annotationsHeadSha: latestScan.headSha,
    };
  }

  private toLatestScanDto(
    latestScan:
      | ({
          id: string;
          status: LatestScanDto['status'];
          criticalCount: number;
          suppressedCount: number;
          finishedAt: Date | null;
        } & AiScanFieldsRow)
      | null,
  ): LatestScanDto | null {
    if (!latestScan) {
      return null;
    }
    return new LatestScanDto({
      id: latestScan.id,
      status: latestScan.status,
      criticalCount: latestScan.criticalCount,
      suppressedCount: latestScan.suppressedCount,
      finishedAt: latestScan.finishedAt,
      ...toApiAiScanFields(latestScan),
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
      description: attrs.description ?? null,
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
      description: pr.body ?? null,
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
