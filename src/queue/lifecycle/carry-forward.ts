import { parsePatch } from '../diff/diff-parser';
import { mapLineThroughHunks } from './line-mapping';

export interface CarryFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  patch: string | null;
}

export interface CarryableFinding {
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

export interface Carried<T> {
  finding: T;
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

// Carries the base scan's findings through an incremental diff (prev head →
// new head): what the diff did not touch persists (lines shifted as needed,
// path updated on rename); what it deleted or replaced is resolved. No
// rule or model looks at an untouched line again.
export function carryForward<T extends CarryableFinding>(
  findings: T[],
  files: CarryFile[],
): { persisted: Carried<T>[]; resolved: T[] } {
  const byOldPath = new Map<string, CarryFile>();
  for (const file of files) {
    byOldPath.set(
      file.status === 'renamed' && file.previousPath
        ? file.previousPath
        : file.path,
      file,
    );
  }

  const result: { persisted: Carried<T>[]; resolved: T[] } = {
    persisted: [],
    resolved: [],
  };
  for (const finding of findings) {
    const file = byOldPath.get(finding.filePath);
    if (!file) {
      result.persisted.push({
        finding,
        filePath: finding.filePath,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
      });
      continue;
    }
    if (file.status === 'removed') {
      result.resolved.push(finding);
      continue;
    }
    // No patch: binary or too large for the provider to diff. The file
    // changed but its lines cannot be mapped — keep the finding where it
    // was rather than silently closing a possibly real issue.
    if (file.patch === null) {
      result.persisted.push({
        finding,
        filePath: file.path,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
      });
      continue;
    }
    const mapped = mapLineThroughHunks(
      parsePatch(file.patch),
      finding.lineStart,
      finding.lineEnd,
    );
    if (!mapped) {
      result.resolved.push(finding);
      continue;
    }
    result.persisted.push({
      finding,
      filePath: file.path,
      lineStart: mapped.start,
      lineEnd: mapped.end,
    });
  }
  return result;
}
