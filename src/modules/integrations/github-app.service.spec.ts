import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request } from '@octokit/request';
import { RequestError } from '@octokit/request-error';
import { GithubAppService } from './github-app.service';

// @nestjs/config v12 and @octokit/* ship ESM-only builds this CommonJS Jest
// setup cannot load — replaced wholesale, as in the other specs.
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@octokit/auth-app', () => ({
  createAppAuth: () => () => Promise.resolve({ token: 'app-jwt' }),
}));
jest.mock('@octokit/request', () => ({ request: jest.fn() }));
jest.mock('@octokit/request-error', () => ({
  RequestError: class RequestError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));

const requestMock = request as unknown as jest.Mock;
const GithubRequestError = RequestError as unknown as new (
  message: string,
  status: number,
) => Error;

function setup() {
  const config = { getOrThrow: () => 'value' };
  return new GithubAppService(config as unknown as ConfigService);
}

describe('GithubAppService.deleteInstallation', () => {
  beforeEach(() => requestMock.mockReset());

  it('uninstalls the App as the App itself', async () => {
    requestMock.mockResolvedValue({ status: 204 });
    await setup().deleteInstallation('169478542');
    expect(requestMock).toHaveBeenCalledWith(
      'DELETE /app/installations/{installation_id}',
      expect.objectContaining({
        installation_id: 169478542,
        headers: { authorization: 'bearer app-jwt' },
      }),
    );
  });

  // Uninstalled on GitHub first: already the outcome the caller wants.
  it('treats 404 as already uninstalled', async () => {
    requestMock.mockRejectedValue(new GithubRequestError('Not Found', 404));
    await expect(setup().deleteInstallation('1')).resolves.toBeUndefined();
  });

  // The caller must not forget an installation that may still be there.
  it.each([500, 403])(
    'fails with 502 github_unreachable on %s',
    async (status) => {
      requestMock.mockRejectedValue(new GithubRequestError('boom', status));
      await expect(setup().deleteInstallation('1')).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
        response: { message: 'github_unreachable' },
      });
    },
  );

  it('fails with 502 github_unreachable on a timeout', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    requestMock.mockRejectedValue(timeout);
    await expect(setup().deleteInstallation('1')).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
    });
  });
});

// v1.5.2: a review decision as the App's bot.
describe('GithubAppService.submitPullReview', () => {
  beforeEach(() => requestMock.mockReset());

  const submit = () =>
    setup().submitPullReview('1', 'acme', 'web', '12', {
      commitId: 'abc123',
      event: 'APPROVE',
      body: 'Approved by Ilham via Critiq.',
    });

  it('posts the review on the commit', async () => {
    requestMock.mockResolvedValue({ status: 200 });
    await submit();
    expect(requestMock).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      expect.objectContaining({
        pull_number: 12,
        commit_id: 'abc123',
        event: 'APPROVE',
      }),
    );
  });

  it.each([
    [403, 'insufficient_permission', false],
    [404, 'insufficient_permission', false],
    [422, 'not_allowed', false],
    [503, 'provider_unreachable', true],
  ])('maps %i to %s', async (status, code, retryable) => {
    requestMock.mockRejectedValue(new GithubRequestError('boom', status));
    await expect(submit()).rejects.toMatchObject({ code, retryable });
  });
});

// v1.5.2: merging from Critiq as the App.
describe('GithubAppService.mergePullRequest', () => {
  beforeEach(() => requestMock.mockReset());

  const merge = () =>
    setup().mergePullRequest('1', 'acme', 'web', '12', {
      sha: 'abc123',
      method: 'squash',
    });

  it('merges pinned to the head with the chosen method', async () => {
    requestMock.mockResolvedValue({ status: 200 });
    await merge();
    expect(requestMock).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge',
      expect.objectContaining({
        pull_number: 12,
        sha: 'abc123',
        merge_method: 'squash',
      }),
    );
  });

  it.each([
    [409, 'head_changed'],
    [405, 'not_mergeable'],
    [422, 'not_mergeable'],
    [403, 'insufficient_permission'],
    [502, 'provider_unreachable'],
  ])('maps %i to %s', async (status, code) => {
    requestMock.mockRejectedValue(
      new GithubRequestError('Pull Request is not mergeable', status),
    );
    await expect(merge()).rejects.toMatchObject({ code });
  });

  // The merge already happened; a branch that cannot go stays.
  it('reports a branch it could not delete without throwing', async () => {
    requestMock.mockRejectedValue(
      new GithubRequestError('Reference does not exist', 422),
    );
    await expect(
      setup().deleteBranch('1', 'acme', 'web', 'feature'),
    ).resolves.toBe(false);
  });
});

// v1.5.2: comments as the App.
describe('GithubAppService comments', () => {
  beforeEach(() => requestMock.mockReset());

  it('places a review comment on the line and side', async () => {
    requestMock.mockResolvedValue({ data: { id: 800 } });
    await expect(
      setup().createReviewComment('1', 'acme', 'web', '12', {
        body: 'nit',
        commitId: 'abc',
        path: 'a.ts',
        line: 9,
        side: 'RIGHT',
      }),
    ).resolves.toEqual({ id: 800 });
    expect(requestMock).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      expect.objectContaining({
        commit_id: 'abc',
        path: 'a.ts',
        line: 9,
        side: 'RIGHT',
      }),
    );
  });

  it.each([
    [422, 'invalid_position', false],
    [403, 'insufficient_permission', false],
    [500, 'provider_unreachable', true],
  ])('maps %i to %s', async (status, code, retryable) => {
    requestMock.mockRejectedValue(new GithubRequestError('boom', status));
    await expect(
      setup().createIssueComment('1', 'acme', 'web', '12', 'hi'),
    ).rejects.toMatchObject({ code, retryable });
  });
});
