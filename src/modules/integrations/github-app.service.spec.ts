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
