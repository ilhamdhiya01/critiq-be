// A PR as an org-wide list item points at it (dashboard, activity): enough
// to label it and link to its page.
export interface PullRefDto {
  id: string;
  number: string;
  title: string;
  repoId: string;
  repoPath: string;
}

export const PULL_REF_SELECT = {
  id: true,
  externalId: true,
  title: true,
  repositoryId: true,
  repository: { select: { path: true } },
} as const;

export function toPullRef(pull: {
  id: string;
  externalId: string;
  title: string;
  repositoryId: string;
  repository: { path: string };
}): PullRefDto {
  return {
    id: pull.id,
    number: pull.externalId,
    title: pull.title,
    repoId: pull.repositoryId,
    repoPath: pull.repository.path,
  };
}
