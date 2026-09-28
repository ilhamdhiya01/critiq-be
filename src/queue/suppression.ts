import { SuppressionReason } from '../generated/prisma/enums';
import { isInsideComment } from './rules/comment-span';
import {
  isDataFixturePath,
  isMustScanPath,
  isTestLikePath,
} from './rules/path-filter';
import { isInsideRegexLiteral } from './rules/regex-literal';

export interface SuppressionInput {
  ruleId: string;
  filePath: string;
  language: string;
  // The added line the match sits on, and where on it. Absent for file rules
  // (path-only) and for rules that don't report a column — those can only
  // be suppressed by path.
  lineText?: string;
  match?: { start: number; length: number };
}

// code.* rules that ARE suppressed in test files: disabling TLS against a
// mock server and a leftover `debugger;` are routine and harmless in tests.
// eval / SQL concat / shell injection are not on this list — that code runs
// in CI, and dynamic input there can still hurt.
const TEST_SUPPRESSED_CODE_RULES = new Set([
  'code.insecure_tls',
  'code.debugger_left',
]);

// code.* rules checked for regex literals. The others (eval, SQL, shell) are
// not: a regex rarely contains `eval(`, and when one does it should surface.
const REGEX_AWARE_CODE_RULES = new Set(['code.insecure_tls']);

function isSecretOrConfig(ruleId: string): boolean {
  return ruleId.startsWith('secret.') || ruleId.startsWith('config.');
}

export function suppressesOnTestFile(ruleId: string): boolean {
  return isSecretOrConfig(ruleId) || TEST_SUPPRESSED_CODE_RULES.has(ruleId);
}

// Same families as test files (v1.5.0 delta 2): a secret or an insecure
// option in a comment is documentation or dead code. eval / SQL / shell are
// not — and their rules already skip comment-only lines themselves.
export function suppressesOnComment(ruleId: string): boolean {
  return suppressesOnTestFile(ruleId);
}

export function isRegexAware(ruleId: string): boolean {
  return isSecretOrConfig(ruleId) || REGEX_AWARE_CODE_RULES.has(ruleId);
}

// Decides, per finding, whether it is stored as active (null) or suppressed.
// Lives here rather than in each rule so a rule added later cannot forget it.
// One reason per finding, in priority order: TEST_FILE > COMMENT >
// REGEX_LITERAL.
export function classifySuppression(
  input: SuppressionInput,
): SuppressionReason | null {
  // Fixtures/testdata are inert data: every family, eval/SQL/shell included.
  if (isDataFixturePath(input.filePath)) {
    return SuppressionReason.TEST_FILE;
  }
  if (isTestLikePath(input.filePath) && suppressesOnTestFile(input.ruleId)) {
    return SuppressionReason.TEST_FILE;
  }
  // Config/infra files are exempt: a commented-out key in `.env` is still
  // in git history (deliberate deviation from the delta-2 spec).
  if (
    suppressesOnComment(input.ruleId) &&
    input.match &&
    input.lineText !== undefined &&
    !isMustScanPath(input.filePath) &&
    isInsideComment(input.lineText, input.match.start, input.filePath)
  ) {
    return SuppressionReason.COMMENT;
  }
  if (
    isRegexAware(input.ruleId) &&
    input.match &&
    input.lineText !== undefined &&
    isInsideRegexLiteral(
      input.lineText,
      input.match.start,
      input.match.length,
      input.language,
    )
  ) {
    return SuppressionReason.REGEX_LITERAL;
  }
  return null;
}
