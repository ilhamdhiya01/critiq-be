import { CiSource, CiState } from '../../generated/prisma/enums';
import {
  GithubCheckRunPayload,
  GithubStatusPayload,
  GitlabPipelinePayload,
} from './webhook-payload';

// One CI result as Critiq stores it. Null from a mapper = nothing to record
// (a skipped or manual pipeline, a check that did not run).
export interface CiCheckInput {
  headSha: string;
  source: CiSource;
  name: string;
  state: CiState;
  url: string | null;
}

// A neutral or skipped check did not fail the commit.
const CHECK_RUN_SUCCESS = new Set(['success', 'neutral', 'skipped']);

export function fromGithubCheckRun(
  payload: GithubCheckRunPayload,
): CiCheckInput {
  const run = payload.check_run;
  const state =
    run.status !== 'completed'
      ? CiState.PENDING
      : CHECK_RUN_SUCCESS.has(run.conclusion ?? '')
        ? CiState.SUCCESS
        : CiState.FAILURE;
  return {
    headSha: run.head_sha,
    source: CiSource.GITHUB_CHECK_RUN,
    // Two apps may both report a check called "build".
    name: run.app?.slug ? `${run.app.slug}/${run.name}` : run.name,
    state,
    url: run.html_url ?? null,
  };
}

const STATUS_STATE: Record<string, CiState> = {
  pending: CiState.PENDING,
  success: CiState.SUCCESS,
  failure: CiState.FAILURE,
  error: CiState.FAILURE,
};

export function fromGithubStatus(
  payload: GithubStatusPayload,
): CiCheckInput | null {
  const state = STATUS_STATE[payload.state];
  return state
    ? {
        headSha: payload.sha,
        source: CiSource.GITHUB_STATUS,
        name: payload.context,
        state,
        url: payload.target_url ?? null,
      }
    : null;
}

const PIPELINE_STATE: Record<string, CiState> = {
  created: CiState.PENDING,
  waiting_for_resource: CiState.PENDING,
  preparing: CiState.PENDING,
  pending: CiState.PENDING,
  running: CiState.PENDING,
  scheduled: CiState.PENDING,
  success: CiState.SUCCESS,
  failed: CiState.FAILURE,
  canceled: CiState.FAILURE,
};

// skipped / manual: the pipeline did not run, so it says nothing either way.
export function fromGitlabPipeline(
  payload: GitlabPipelinePayload,
): CiCheckInput | null {
  const attrs = payload.object_attributes;
  const state = PIPELINE_STATE[attrs.status];
  return state
    ? {
        headSha: attrs.sha,
        source: CiSource.GITLAB_PIPELINE,
        // One row per commit: a retried pipeline replaces the failed one.
        name: 'pipeline',
        state,
        url: attrs.url ?? null,
      }
    : null;
}
