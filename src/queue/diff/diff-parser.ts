export interface DiffLine {
  type: 'add' | 'del' | 'context';
  // Line number on the "new" (post-change) side — null for 'del' lines,
  // since a deleted line has no position in the new file.
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  newStart: number;
  lines: DiffLine[];
}

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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

  for (const rawLine of patch.split('\n')) {
    const headerMatch = HUNK_HEADER_PATTERN.exec(rawLine);
    if (headerMatch) {
      nextNewLine = Number(headerMatch[1]);
      currentHunk = { newStart: nextNewLine, lines: [] };
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
        text: rawLine.slice(1),
      });
      nextNewLine += 1;
    } else if (rawLine.startsWith('-')) {
      currentHunk.lines.push({
        type: 'del',
        newLine: null,
        text: rawLine.slice(1),
      });
    } else if (rawLine.startsWith(' ') || rawLine === '') {
      currentHunk.lines.push({
        type: 'context',
        newLine: nextNewLine,
        text: rawLine.slice(1),
      });
      nextNewLine += 1;
    }
    // Any other prefix (e.g. "\ No newline at end of file") is neither an
    // add/del/context line — skipped.
  }

  return hunks;
}
