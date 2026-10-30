import type { Request, Response } from 'express';
import { originCheck } from './origin-check.middleware';

const FE_URL = 'https://critiq-dev.web.id';

function run(
  method: string,
  path: string,
  headers: Record<string, string> = {},
) {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  originCheck(FE_URL)(
    { method, path, headers } as unknown as Request,
    res as unknown as Response,
    next,
  );
  return { allowed: next.mock.calls.length === 1, res };
}

describe('originCheck', () => {
  it('lets the FE origin change state', () => {
    expect(
      run('POST', '/api/v1/orgs', { origin: 'https://critiq-dev.web.id' })
        .allowed,
    ).toBe(true);
  });

  // A form on another site posting with the victim's cookie.
  it('refuses another origin with 403 origin_not_allowed', () => {
    const { allowed, res } = run('POST', '/api/v1/orgs', {
      origin: 'https://evil.example',
    });
    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      errors: [{ field: '', message: 'origin_not_allowed' }],
    });
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('checks %s too', (method) => {
    expect(
      run(method, '/api/v1/orgs/o/rules', { origin: 'null' }).allowed,
    ).toBe(false);
  });

  it('refuses a cross-site request without Origin', () => {
    expect(
      run('POST', '/api/v1/orgs', { 'sec-fetch-site': 'cross-site' }).allowed,
    ).toBe(false);
  });

  it('lets a non-browser client through to the guards', () => {
    expect(run('POST', '/api/v1/orgs').allowed).toBe(true);
  });

  it('leaves reads alone', () => {
    expect(
      run('GET', '/api/v1/orgs/o/repos', { origin: 'https://evil.example' })
        .allowed,
    ).toBe(true);
  });

  it('exempts provider webhooks', () => {
    expect(
      run('POST', '/api/v1/webhooks/github', {
        'sec-fetch-site': 'cross-site',
      }).allowed,
    ).toBe(true);
  });
});
