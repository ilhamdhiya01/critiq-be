import { FindingSeverity } from '../../../generated/prisma/enums';

export class PullRequestFileDto {
  path!: string;
  previousPath!: string | null;
  status!: 'added' | 'removed' | 'modified' | 'renamed';
  additions!: number | null;
  deletions!: number | null;
  patch!: string | null;
  truncated!: boolean;

  constructor(partial: {
    path: string;
    previousPath: string | null;
    status: 'added' | 'removed' | 'modified' | 'renamed';
    additions: number | null;
    deletions: number | null;
    patch: string | null;
    truncated: boolean;
  }) {
    Object.assign(this, partial);
  }
}

export interface DiffAnnotation {
  findingId: string;
  lineStart: number;
  lineEnd: number;
  severity: FindingSeverity;
}

// filePath → the findings to mark on that file's lines.
export type DiffAnnotations = Record<string, DiffAnnotation[]>;

export class PullRequestDiffDto {
  files!: PullRequestFileDto[];
  truncated!: boolean;
  // From the PR's latestScan: active findings, and suppressed ones (which
  // the FE shows muted, if at all). Both {} when the PR has no scan yet.
  annotations!: DiffAnnotations;
  suppressedAnnotations!: DiffAnnotations;
  // Which scan the annotations came from. The diff is fetched live, the
  // scan is not: after a new push, until that push is scanned, headSha here
  // differs from the PR's and the line numbers may not match the diff.
  annotationsScanId!: string | null;
  annotationsHeadSha!: string | null;

  constructor(partial: {
    files: PullRequestFileDto[];
    truncated: boolean;
    annotations: DiffAnnotations;
    suppressedAnnotations: DiffAnnotations;
    annotationsScanId: string | null;
    annotationsHeadSha: string | null;
  }) {
    Object.assign(this, partial);
  }
}
