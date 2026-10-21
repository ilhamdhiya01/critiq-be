import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GithubInstallCallbackDto } from './github-install-callback.dto';

const errorsFor = (query: Record<string, unknown>) =>
  validate(plainToInstance(GithubInstallCallbackDto, query));

describe('GithubInstallCallbackDto', () => {
  // A non-owner's request: GitHub has no installation to name yet.
  it('accepts a request without installation_id', async () => {
    expect(
      await errorsFor({ setup_action: 'request', state: 's' }),
    ).toHaveLength(0);
  });

  it.each([
    [{ setup_action: 'install', state: 's' }],
    [{ setup_action: 'update' }],
    [{ setup_action: 'request', installation_id: 'abc' }],
  ])('rejects %p', async (query) => {
    expect((await errorsFor(query)).length).toBeGreaterThan(0);
  });

  it('accepts an install with its id', async () => {
    expect(
      await errorsFor({
        setup_action: 'install',
        installation_id: '169099670',
      }),
    ).toHaveLength(0);
  });
});
