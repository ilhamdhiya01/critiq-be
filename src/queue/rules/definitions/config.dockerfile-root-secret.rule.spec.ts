import { runRuleAgainstFixture } from '../test-helpers';
import { configDockerfileRootSecretRule } from './config.dockerfile-root-secret.rule';

describe('config.dockerfile_root_secret', () => {
  it.each(['Dockerfile.positive-1', 'Dockerfile.positive-2'])(
    'flags %s',
    (fixture) => {
      const result = runRuleAgainstFixture(
        configDockerfileRootSecretRule,
        fixture,
      );
      expect(result.hits).toHaveLength(1);
    },
  );

  it.each(['Dockerfile.negative-1', 'Dockerfile.negative-2'])(
    'does not flag %s',
    (fixture) => {
      const result = runRuleAgainstFixture(
        configDockerfileRootSecretRule,
        fixture,
      );
      expect(result.hits).toHaveLength(0);
    },
  );
});
