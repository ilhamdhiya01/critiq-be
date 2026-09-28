import { parsePatch } from './diff/diff-parser';
import { PreparedFinding, LocatedHit, dedupeFindings } from './dedupe-findings';
import { detectLanguage } from './rules/language-detector';
import { isIgnoredPath } from './rules/path-filter';
import {
  FilteredCandidate,
  RuleCrash,
  runRulesForFile,
} from './rules/rule-runner';
import { RULES } from './rules/rules';
import { Rule } from './rules/rule.interface';
import { classifySuppression } from './suppression';

export const MAX_ACTIVE_FINDINGS = 500;
export const MAX_SUPPRESSED_FINDINGS = 200;

export interface DiffFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  // null when the provider omitted it (binary or oversized file).
  patch: string | null;
}

export interface DiffAnalysis {
  diffBytes: number;
  // True when the scannable diff exceeds maxDiffBytes. No rule has run; the
  // caller fails the scan with diff_too_large.
  diffTooLarge: boolean;
  filesChanged: number;
  filesSkipped: number;
  // Capped for storage, sorted by file then line.
  active: PreparedFinding[];
  suppressed: PreparedFinding[];
  // Real totals before the caps — what criticalCount/suppressedCount store.
  activeCount: number;
  suppressedCount: number;
  findingsTruncated: boolean;
  suppressedTruncated: boolean;
  ruleRuns: number;
  crashes: (RuleCrash & { filePath: string })[];
  filtered: (FilteredCandidate & { filePath: string })[];
  budgetExceededAt: string | null;
  rulesMs: number;
}

export interface AnalyzeDiffOptions {
  maxDiffBytes: number;
  rules?: Rule[];
  // Called after each file; the processor passes its job-deadline check,
  // which throws to abort the scan.
  afterFile?: () => void;
}

function byLocation(a: PreparedFinding, b: PreparedFinding): number {
  return a.filePath.localeCompare(b.filePath) || a.lineStart - b.lineStart;
}

// Everything between "diff fetched" and "rows to write": filter, parse, run
// rules, classify suppression, dedupe, cap. Pure — no DB, provider or Nest —
// so a whole real diff can be replayed in a unit test.
export function analyzeDiff(
  files: DiffFile[],
  options: AnalyzeDiffOptions,
): DiffAnalysis {
  const rules = options.rules ?? RULES;
  const scannableFiles = files.filter(
    (file) => file.patch !== null && !isIgnoredPath(file.path),
  );
  // File rules judge a path, not its contents, so they also see files with
  // no patch — exactly how a real credential file (binary, oversized) arrives.
  const fileRuleCandidates = files.filter((file) => !isIgnoredPath(file.path));
  // Counted over files that will actually be scanned, so a lockfile bump
  // alone can't push a normal PR over the limit.
  const diffBytes = scannableFiles.reduce(
    (sum, file) => sum + Buffer.byteLength(file.patch ?? '', 'utf8'),
    0,
  );

  const analysis: DiffAnalysis = {
    diffBytes,
    diffTooLarge: diffBytes > options.maxDiffBytes,
    filesChanged: files.length,
    filesSkipped: files.length - scannableFiles.length,
    active: [],
    suppressed: [],
    activeCount: 0,
    suppressedCount: 0,
    findingsTruncated: false,
    suppressedTruncated: false,
    ruleRuns: 0,
    crashes: [],
    filtered: [],
    budgetExceededAt: null,
    rulesMs: 0,
  };
  if (analysis.diffTooLarge) {
    return analysis;
  }

  const rulesStartedAt = Date.now();
  const budgetState = { elapsedMs: 0 };
  const hits: LocatedHit[] = [];
  const fileRules = rules.filter((rule) => rule.kind === 'file');
  const lineRules = rules.filter((rule) => rule.kind !== 'file');

  for (const file of fileRuleCandidates) {
    const language = detectLanguage(file.path);
    const result = runRulesForFile({
      rules: fileRules,
      filePath: file.path,
      language,
      addedLines: [],
      budgetState,
      status: file.status,
      previousPath: file.previousPath,
    });
    analysis.ruleRuns += result.ruleRuns;
    analysis.crashes.push(
      ...result.crashes.map((crash) => ({ ...crash, filePath: file.path })),
    );
    for (const hit of result.hits) {
      hits.push({
        ...hit,
        filePath: file.path,
        suppressedReason: classifySuppression({
          ruleId: hit.ruleId,
          filePath: file.path,
          language,
        }),
      });
    }
  }

  for (const file of scannableFiles) {
    const addedLines = parsePatch(file.patch ?? '')
      .flatMap((hunk) => hunk.lines)
      .flatMap((line) =>
        line.type === 'add' && line.newLine !== null
          ? [{ newLine: line.newLine, text: line.text }]
          : [],
      );
    if (addedLines.length === 0) {
      continue;
    }
    const lineText = new Map(
      addedLines.map((line) => [line.newLine, line.text]),
    );
    const language = detectLanguage(file.path);

    const result = runRulesForFile({
      rules: lineRules,
      filePath: file.path,
      language,
      addedLines,
      budgetState,
      status: file.status,
      previousPath: file.previousPath,
      sizeBytes: Buffer.byteLength(file.patch ?? '', 'utf8'),
    });
    analysis.ruleRuns += result.ruleRuns;
    analysis.crashes.push(
      ...result.crashes.map((crash) => ({ ...crash, filePath: file.path })),
    );
    analysis.filtered.push(
      ...result.filtered.map((item) => ({ ...item, filePath: file.path })),
    );
    for (const hit of result.hits) {
      hits.push({
        ...hit,
        filePath: file.path,
        suppressedReason: classifySuppression({
          ruleId: hit.ruleId,
          filePath: file.path,
          language,
          lineText: lineText.get(hit.lineStart),
          match: hit.match,
        }),
      });
    }

    if (result.budgetExceeded) {
      analysis.budgetExceededAt = file.path;
      break;
    }
    options.afterFile?.();
  }
  analysis.rulesMs = Date.now() - rulesStartedAt;

  const deduped = dedupeFindings(hits);
  const active = deduped
    .filter((f) => f.suppressedReason === null)
    .sort(byLocation);
  const suppressed = deduped
    .filter((f) => f.suppressedReason !== null)
    .sort(byLocation);

  analysis.activeCount = active.length;
  analysis.suppressedCount = suppressed.length;
  analysis.active = active.slice(0, MAX_ACTIVE_FINDINGS);
  analysis.suppressed = suppressed.slice(0, MAX_SUPPRESSED_FINDINGS);
  analysis.findingsTruncated =
    analysis.budgetExceededAt !== null || active.length > MAX_ACTIVE_FINDINGS;
  analysis.suppressedTruncated = suppressed.length > MAX_SUPPRESSED_FINDINGS;
  return analysis;
}
