import { readFileSync } from 'fs';
import { join } from 'path';
import { DiffFile } from '../analyze-diff';

// Splits `git diff` output into the per-file shape a provider returns, so a
// real PR's diff can be replayed through analyzeDiff in a spec.
export function splitGitDiff(diff: string): DiffFile[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith('diff --git '))
    .map((section) => {
      const [, from, to] = /^diff --git a\/(\S+) b\/(\S+)/.exec(section) ?? [];
      const hunkAt = section.search(/^@@ /m);
      const status: DiffFile['status'] = /^new file mode/m.test(section)
        ? 'added'
        : /^deleted file mode/m.test(section)
          ? 'removed'
          : from !== to
            ? 'renamed'
            : 'modified';
      return {
        path: to,
        previousPath: status === 'renamed' ? from : null,
        status,
        patch: hunkAt >= 0 ? section.slice(hunkAt) : null,
      };
    });
}

// A diff under src/queue/fixtures/diffs/, split per file.
export function loadDiffFixture(name: string): DiffFile[] {
  return splitGitDiff(
    readFileSync(join(__dirname, '..', 'fixtures', 'diffs', name), 'utf8'),
  );
}
