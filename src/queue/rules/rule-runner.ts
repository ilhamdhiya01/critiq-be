import { Rule, RuleFileContext, RuleFinding } from './rule.interface';
import { ruleAppliesTo } from './language-detector';
import { MAX_LINE_LENGTH } from './rules.constants';
import { isSecretSkippedPath } from './path-filter';
import { FilterReason, filterValue } from './value-filter';

export interface RuleHit extends RuleFinding {
  ruleId: string;
  severity: 'critical';
  title: string;
  message: string;
}

export interface RuleCrash {
  ruleId: string;
  // Error name only, never the message — a rule's thrown message could
  // echo the line text it was matching, which may contain a secret.
  errorName: string;
}

export interface FilteredCandidate {
  ruleId: string;
  line: number;
  reason: FilterReason;
}

export interface RunRulesResult {
  hits: RuleHit[];
  crashes: RuleCrash[];
  // Candidates ValueFilter rejected. Surfaced so the caller can log them at
  // debug for tuning — never persisted, and deliberately carrying no value
  // or line text.
  filtered: FilteredCandidate[];
  // How many applicable rules actually executed on this file — lets the
  // caller detect "every rule crashed" (ruleRuns > 0 && crashes === ruleRuns).
  ruleRuns: number;
  // True once cumulative rule-execution time for the whole scan crosses the
  // budget. A true per-regex timeout isn't possible in synchronous JS; this
  // codebase authors all of its own regexes, so a coarse budget checked
  // between rules is enough to keep one pathological input from hanging a
  // worker slot indefinitely.
  budgetExceeded: boolean;
}

export const RULE_BUDGET_MS = 5000;

export interface RunRulesInput {
  rules: Rule[];
  filePath: string;
  language: string;
  addedLines: { newLine: number; text: string }[];
  budgetState: { elapsedMs: number };
  // Diff metadata — only file rules need it, so it stays optional for the
  // fixture-based specs, which have no diff to take a status from.
  status?: 'added' | 'removed' | 'modified' | 'renamed';
  previousPath?: string | null;
  sizeBytes?: number;
}

// Runs every applicable rule against one file's added lines. A rule that
// throws is isolated (recorded in `crashes`) so the remaining rules still
// run. No logger dependency on purpose — the caller (ScanProcessor) logs,
// keeping this module free of any Nest/winston coupling so it stays
// testable with plain Jest.
//
// Takes a params object rather than positional arguments: diff metadata
// pushed this past five parameters, several of them same-typed strings that
// are easy to transpose silently at a call site.
export function runRulesForFile(input: RunRulesInput): RunRulesResult {
  const {
    rules,
    filePath,
    language,
    addedLines,
    budgetState,
    status,
    previousPath,
    sizeBytes,
  } = input;
  const hits: RuleHit[] = [];
  const crashes: RuleCrash[] = [];
  const filtered: FilteredCandidate[] = [];
  let ruleRuns = 0;

  if (budgetState.elapsedMs >= RULE_BUDGET_MS) {
    return { hits, crashes, filtered, ruleRuns, budgetExceeded: true };
  }

  const secretRulesSkipped = isSecretSkippedPath(filePath);

  // Clipped rather than dropped, so a long line (e.g. a base64 blob that is
  // actually a key) still gets a chance to match on its first N characters.
  const clippedLines = addedLines.map((line) =>
    line.text.length > MAX_LINE_LENGTH
      ? { ...line, text: line.text.slice(0, MAX_LINE_LENGTH) }
      : line,
  );

  const ctx: RuleFileContext = {
    filePath,
    language,
    addedLines: clippedLines,
    status,
    previousPath,
    sizeBytes,
  };

  for (const rule of rules) {
    if (!ruleAppliesTo(rule.languages, language)) {
      continue;
    }
    // Documentation, example env files and test fixtures are where fake
    // credentials legitimately live. Checked as a family prefix rather than
    // a per-rule opt-in so a rule added later can't forget to honour it.
    if (secretRulesSkipped && rule.id.startsWith('secret.')) {
      continue;
    }

    ruleRuns += 1;
    const ruleStartedAt = Date.now();
    try {
      for (const finding of rule.test(ctx)) {
        // ValueFilter decides whether a credential-shaped match is really a
        // credential. Three exemptions, all expressed declaratively: a rule
        // that emitted no candidate has nothing to filter; file rules match
        // on path alone; and provider rules whose prefix already proves
        // provenance opt out via skipValueFilter (AWS publishes
        // AKIAIOSFODNN7EXAMPLE, which reads exactly like a placeholder).
        if (
          finding.candidate &&
          rule.kind !== 'file' &&
          !rule.skipValueFilter
        ) {
          const reason = filterValue(finding.candidate);
          if (reason) {
            filtered.push({
              ruleId: rule.id,
              line: finding.candidate.line,
              reason,
            });
            continue;
          }
        }

        // `candidate` is dropped here: it holds the raw line and the
        // unredacted value, and nothing downstream — hit, DB row or log —
        // may ever see them. Listing the kept fields explicitly rather than
        // spreading-and-deleting makes that guarantee checkable at a glance.
        hits.push({
          lineStart: finding.lineStart,
          lineEnd: finding.lineEnd,
          snippet: finding.snippet,
          ruleId: rule.id,
          severity: rule.severity,
          title: rule.title,
          message: rule.message,
        });
      }
    } catch (error) {
      crashes.push({
        ruleId: rule.id,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    budgetState.elapsedMs += Date.now() - ruleStartedAt;

    if (budgetState.elapsedMs >= RULE_BUDGET_MS) {
      return { hits, crashes, filtered, ruleRuns, budgetExceeded: true };
    }
  }

  return { hits, crashes, filtered, ruleRuns, budgetExceeded: false };
}
