import { IntegrationState } from '../../generated/prisma/enums';
import { assertGithubAccess } from './github-access';

describe('assertGithubAccess', () => {
  it.each([
    [IntegrationState.UNINSTALLED, 'github_uninstalled'],
    [IntegrationState.SUSPENDED, 'github_suspended'],
    // Requested from the owner, not installed: no token can be minted.
    [IntegrationState.PENDING_APPROVAL, 'github_pending_approval'],
  ])('409s %s as %s', (state, message) => {
    let thrown: unknown;
    try {
      assertGithubAccess({ state });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 409, response: { message } });
  });

  it('lets an active installation through', () => {
    expect(() =>
      assertGithubAccess({ state: IntegrationState.ACTIVE }),
    ).not.toThrow();
  });
});
