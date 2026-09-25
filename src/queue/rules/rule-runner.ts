import { Rule, RuleFileContext, RuleFinding } from './rule.interface';
import { ruleAppliesTo } from './language-detector';
import { MAX_LINE_LENGTH } from './rules.constants';

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

export interface RunRulesResult {
  hits: RuleHit[];
  crashes: RuleCrash[];
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

// Runs every applicable rule against one file's added lines. A rule that
// throws is isolated (recorded in `crashes`) so the remaining rules still
// run. No logger dependency on purpose — the caller (ScanProcessor) logs,
// keeping this module free of any Nest/winston coupling so it stays
// testable with plain Jest.
export function runRulesForFile(
  rules: Rule[],
  filePath: string,
  language: string,
  addedLines: { newLine: number; text: string }[],
  budgetState: { elapsedMs: number },
): RunRulesResult {
  const hits: RuleHit[] = [];
  const crashes: RuleCrash[] = [];
  let ruleRuns = 0;

  if (budgetState.elapsedMs >= RULE_BUDGET_MS) {
    return { hits, crashes, ruleRuns, budgetExceeded: true };
  }

  // Clipped rather than dropped, so a long line (e.g. a base64 blob that is
  // actually a key) still gets a chance to match on its first N characters.
  const clippedLines = addedLines.map((line) =>
    line.text.length > MAX_LINE_LENGTH
      ? { ...line, text: line.text.slice(0, MAX_LINE_LENGTH) }
      : line,
  );

  const ctx: RuleFileContext = { filePath, language, addedLines: clippedLines };

  for (const rule of rules) {
    if (!ruleAppliesTo(rule.languages, language)) {
      continue;
    }

    ruleRuns += 1;
    const ruleStartedAt = Date.now();
    try {
      for (const finding of rule.test(ctx)) {
        hits.push({
          ...finding,
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
      return { hits, crashes, ruleRuns, budgetExceeded: true };
    }
  }

  return { hits, crashes, ruleRuns, budgetExceeded: false };
}
