import { FindingCategory } from '../generated/prisma/enums';
import { SYNTAX_RULE_ID } from './rules/syntax/syntax-check';

// Category of a static rule — the shared vocabulary AI findings are deduped
// against (v1.5.1 langkah 2). Must stay in step with the backfill in the
// `add_ai_scan` migration, which applied the same mapping to existing rows.
const INJECTION_RULES = new Set([
  'code.sql_string_concat',
  'code.shell_injection',
  'code.eval_dynamic',
]);

export function categoryForRule(ruleId: string): FindingCategory {
  if (ruleId.startsWith('secret.')) {
    return FindingCategory.SECRET;
  }
  if (INJECTION_RULES.has(ruleId)) {
    return FindingCategory.INJECTION;
  }
  if (ruleId === 'code.insecure_tls') {
    return FindingCategory.INSECURE_TLS;
  }
  if (ruleId.startsWith('config.')) {
    return FindingCategory.CONFIG;
  }
  // What an AI review files a broken brace under — so the two dedupe.
  if (ruleId === SYNTAX_RULE_ID) {
    return FindingCategory.LOGIC;
  }
  return FindingCategory.OTHER;
}
