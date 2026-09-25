import { runRuleAgainstFixture } from '../test-helpers';
import { secretGitlabTokenRule } from './secret.gitlab-token.rule';

describe('secret.gitlab_token', () => {
  it.each(['positive-1.ts', 'positive-2.yml'])('flags %s', (fixture) => {
    const result = runRuleAgainstFixture(secretGitlabTokenRule, fixture);
    expect(result.hits).toHaveLength(1);
  });

  it.each(['negative-1.ts', 'negative-2.ts'])('does not flag %s', (fixture) => {
    const result = runRuleAgainstFixture(secretGitlabTokenRule, fixture);
    expect(result.hits).toHaveLength(0);
  });
});
