export interface DiffLine {
  type: 'add' | 'del' | 'context';
  // Line number on the "new" (post-change) side — null for 'del' lines,
  // since a deleted line has no position in the new file.
  newLine: number | null;
  // Line number on the "old" (pre-change) side — null for 'add' lines.
  // Used to carry findings forward across pushes (v1.5.1 langkah 3).
  oldLine: number | null;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  // Old-side line count from the header (`-12,3`); 0 for a pure insertion,
  // whose oldStart is the line the insertion follows.
  oldCount: number;
  newStart: number;
  lines: DiffLine[];
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/;

// Parses a single file's unified-diff patch text (the shape both
// GithubPullRequestFile.patch and the mapped GitlabMergeRequestDiff.diff
// already come in as — see PullsService's mapGithubFile/mapGitlabDiff) into
// hunks with per-line new-side line numbers. Only 'add' lines are ever
// passed to a Rule — context and 'del' lines are kept here for
// completeness/future use but the rule runner filters them out.
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let nextNewLine = 0;
  let nextOldLine = 0;

  for (const rawLine of patch.split('\n')) {
    const headerMatch = HUNK_HEADER_PATTERN.exec(rawLine);
    if (headerMatch) {
      nextOldLine = Number(headerMatch[1]);
      nextNewLine = Number(headerMatch[3]);
      currentHunk = {
        oldStart: nextOldLine,
        oldCount: headerMatch[2] === undefined ? 1 : Number(headerMatch[2]),
        newStart: nextNewLine,
        lines: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      // Content before the first @@ header (e.g. a "\ No newline at end of
      // file" marker or file-level headers some providers include) — not
      // part of any hunk, safely ignored.
      continue;
    }

    if (rawLine.startsWith('+')) {
      currentHunk.lines.push({
        type: 'add',
        newLine: nextNewLine,
        oldLine: null,
        text: rawLine.slice(1),
      });
      nextNewLine += 1;
    } else if (rawLine.startsWith('-')) {
      currentHunk.lines.push({
        type: 'del',
        newLine: null,
        oldLine: nextOldLine,
        text: rawLine.slice(1),
      });
      nextOldLine += 1;
    } else if (rawLine.startsWith(' ') || rawLine === '') {
      currentHunk.lines.push({
        type: 'context',
        newLine: nextNewLine,
        oldLine: nextOldLine,
        text: rawLine.slice(1),
      });
      nextNewLine += 1;
      nextOldLine += 1;
    }
    // Any other prefix (e.g. "\ No newline at end of file") is neither an
    // add/del/context line — skipped.
  }

  return hunks;
}
