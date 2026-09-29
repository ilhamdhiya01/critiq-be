import { DiffHunk } from '../diff/diff-parser';

// Where an old-side line ends up after a diff, or null when the line was
// deleted or replaced. A line outside every hunk's changed part is, by the
// definition of a unified diff, byte-identical in the new file — that is
// what lets a finding be carried forward without re-reading the file.
export function mapOldLine(hunks: DiffHunk[], oldLine: number): number | null {
  let offset = 0;
  for (const hunk of hunks) {
    // A pure insertion (`-12,0`) sits after old line 12.
    const firstOld = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    if (oldLine < firstOld) {
      return oldLine + offset;
    }
    const lastOld = firstOld + hunk.oldCount - 1;
    if (oldLine <= lastOld) {
      for (const line of hunk.lines) {
        if (line.oldLine === oldLine) {
          return line.type === 'context' ? line.newLine : null;
        }
      }
      return null;
    }
    const added = hunk.lines.filter((line) => line.type === 'add').length;
    const deleted = hunk.lines.filter((line) => line.type === 'del').length;
    offset += added - deleted;
  }
  return oldLine + offset;
}

// A finding's range survives only if every line in it does.
export function mapLineThroughHunks(
  hunks: DiffHunk[],
  oldStart: number,
  oldEnd: number,
): { start: number; end: number } | null {
  let start: number | null = null;
  let end: number | null = null;
  for (let line = oldStart; line <= oldEnd; line += 1) {
    const mapped = mapOldLine(hunks, line);
    if (mapped === null) {
      return null;
    }
    start ??= mapped;
    end = mapped;
  }
  return start === null || end === null ? null : { start, end };
}
