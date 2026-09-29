import { FindingCategory } from '../generated/prisma/enums';
import { categoryForRule } from './finding-category';
import { RULES } from './rules/rules';

describe('categoryForRule', () => {
  it.each([
    ['secret.aws_access_key', FindingCategory.SECRET],
    ['secret.sensitive_file_added', FindingCategory.SECRET],
    ['code.sql_string_concat', FindingCategory.INJECTION],
    ['code.shell_injection', FindingCategory.INJECTION],
    ['code.eval_dynamic', FindingCategory.INJECTION],
    ['code.insecure_tls', FindingCategory.INSECURE_TLS],
    ['code.debugger_left', FindingCategory.OTHER],
    ['config.cors_wildcard_credentials', FindingCategory.CONFIG],
  ])('%s → %s', (ruleId, category) => {
    expect(categoryForRule(ruleId)).toBe(category);
  });

  // The add_ai_scan migration backfilled with the same mapping; a new rule
  // family would need both updated.
  it('gives every registered rule a category', () => {
    for (const rule of RULES) {
      expect(Object.values(FindingCategory)).toContain(
        categoryForRule(rule.id),
      );
    }
  });
});
