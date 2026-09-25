import { RULES } from './rules';

describe('RULES', () => {
  it('has no duplicate rule ids', () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only emits critical severity in this MVP', () => {
    for (const rule of RULES) {
      expect(rule.severity).toBe('critical');
    }
  });

  it('registers all 16 rules from the v1.5.0 rule table', () => {
    expect(RULES).toHaveLength(16);
  });
});
