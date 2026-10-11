import {
  FindingCategory,
  FindingSource,
  RuleTier,
} from '../../generated/prisma/enums';
import {
  ALL_RULE_TIERS,
  enabledTiers,
  isFindingEnabled,
  sameTiers,
  tierForCategory,
  tierForRule,
  tierKey,
} from './rule-tiers';

describe('rule tiers', () => {
  it.each([
    ['secret.aws_access_key', RuleTier.SECRETS],
    ['config.dockerfile_root_secret', RuleTier.SECRETS],
    ['code.syntax_error', RuleTier.CRASH],
    ['code.debugger_left', RuleTier.CRASH],
    ['code.empty_catch', RuleTier.ERROR_HANDLING],
    ['code.sql_string_concat', RuleTier.SECURITY],
    ['config.cors_wildcard_credentials', RuleTier.SECURITY],
    ['code.unknown', null],
  ])('puts %s in %s', (ruleId, tier) => {
    expect(tierForRule(ruleId)).toBe(tier);
  });

  it.each([
    [FindingCategory.PERFORMANCE, RuleTier.PERFORMANCE],
    [FindingCategory.BREAKING_CHANGE, RuleTier.BREAKING_CHANGE],
    [FindingCategory.DATA_LOSS, RuleTier.SECURITY],
    [FindingCategory.CONCURRENCY, RuleTier.CRASH],
    [FindingCategory.LOGIC, null],
    [FindingCategory.OTHER, null],
  ])('puts AI category %s in %s', (category, tier) => {
    expect(tierForCategory(category)).toBe(tier);
  });

  it('keeps findings of enabled tiers and findings with no tier', () => {
    const tiers = enabledTiers([RuleTier.SECURITY]);
    expect(
      isFindingEnabled(
        {
          source: FindingSource.STATIC,
          ruleId: 'code.insecure_tls',
          category: FindingCategory.INSECURE_TLS,
        },
        tiers,
      ),
    ).toBe(false);
    expect(
      isFindingEnabled(
        {
          source: FindingSource.AI,
          ruleId: 'ai.logic',
          category: FindingCategory.LOGIC,
        },
        [],
      ),
    ).toBe(true);
  });

  it('compares and keys tier sets regardless of order', () => {
    const reversed = [...ALL_RULE_TIERS].reverse();
    expect(sameTiers(reversed, ALL_RULE_TIERS)).toBe(true);
    expect(sameTiers(ALL_RULE_TIERS.slice(1), ALL_RULE_TIERS)).toBe(false);
    expect(tierKey(reversed)).toBe(tierKey(ALL_RULE_TIERS));
  });
});
