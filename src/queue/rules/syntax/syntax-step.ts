import { isIgnoredPath } from '../path-filter';
import {
  checkSyntax,
  SyntaxHit,
  syntaxKindOf,
  SyntaxSkip,
} from './syntax-check';

export interface SyntaxStepFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  patch: string | null;
  truncated?: boolean;
}

export interface SyntaxStepResult {
  hits: SyntaxHit[];
  // Head paths with a definitive answer — broken (a hit) or parsing — whose
  // earlier syntax finding is decided again rather than carried.
  decidedPaths: Set<string>;
  // Per reason, for the scan log; never paths or content.
  skipped: Partial<Record<SyntaxSkip | 'unavailable' | 'capped', number>>;
}

// The changed files the check can read: still present, with a complete
// patch (the base is rebuilt from it), not generated/vendored, in a
// supported language. The first `maxFiles` in diff order; the rest counted.
export function syntaxCheckFiles(
  files: SyntaxStepFile[],
  maxFiles: number,
): { files: (SyntaxStepFile & { patch: string })[]; capped: number } {
  const eligible = files.filter(
    (file): file is SyntaxStepFile & { patch: string } =>
      file.status !== 'removed' &&
      file.patch !== null &&
      !file.truncated &&
      !isIgnoredPath(file.path) &&
      syntaxKindOf(file.path) !== null,
  );
  return {
    files: eligible.slice(0, maxFiles),
    capped: Math.max(0, eligible.length - maxFiles),
  };
}

export function runSyntaxChecks(
  files: (SyntaxStepFile & { patch: string })[],
  contents: Map<string, string | null>,
  options: {
    // Head paths whose base scan already holds a syntax finding.
    knownBroken: Set<string>;
    capped: number;
    afterFile?: () => void;
  },
): SyntaxStepResult {
  const result: SyntaxStepResult = {
    hits: [],
    decidedPaths: new Set(),
    skipped: {},
  };
  const skip = (reason: keyof SyntaxStepResult['skipped'], by = 1) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + by;
  };
  if (options.capped > 0) {
    skip('capped', options.capped);
  }
  for (const file of files) {
    const head = contents.get(file.path) ?? null;
    if (head === null) {
      skip('unavailable');
      continue;
    }
    const outcome = checkSyntax({
      path: file.path,
      status: file.status,
      patch: file.patch,
      head,
      skipBaseCheck: options.knownBroken.has(file.path),
    });
    if ('hit' in outcome) {
      result.hits.push(outcome.hit);
      result.decidedPaths.add(file.path);
    } else {
      if (outcome.skipped === 'parses') {
        result.decidedPaths.add(file.path);
      }
      skip(outcome.skipped);
    }
    options.afterFile?.();
  }
  return result;
}
