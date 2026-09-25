import { runRuleAgainstFixture } from '../test-helpers';
import { secretGithubTokenRule } from './secret.github-token.rule';

describe('secret.github_token', () => {
  it.each(['positive-1.ts', 'positive-2.yml'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(secretGithubTokenRule, fixture);
    expect(result.hits).toHaveLength(1);
  });

  it.each(['negative-1.ts', 'negative-2.ts'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(secretGithubTokenRule, fixture);
    expect(result.hits).toHaveLength(0);
  });
});
