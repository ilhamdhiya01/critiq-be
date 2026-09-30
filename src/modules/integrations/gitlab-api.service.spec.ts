import { HttpService } from '@nestjs/axios';
import { AxiosError, AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { GitlabApiService } from './gitlab-api.service';

// ESM-only package; the service only needs `get`, supplied below.
jest.mock('@nestjs/axios', () => ({ HttpService: class {} }));

function axiosError(status: number): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError('failed', String(status), { headers }, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers },
    data: {},
  });
}

function setup() {
  const http = { get: jest.fn() };
  const service = new GitlabApiService(http as unknown as HttpService);
  const lastParams = () =>
    (
      http.get.mock.calls.at(-1) as [
        string,
        { params?: Record<string, unknown> },
      ]
    )[1].params;
  return { http, service, lastParams };
}

const names = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `branch-${i}` }));

describe('GitlabApiService branches', () => {
  // A repo with 1000+ issue branches listed by name never reached the
  // active ones (critiq: 5 active branches missing from the picker).
  it('asks for the most recently updated first, one more than the limit', async () => {
    const { http, service, lastParams } = setup();
    http.get.mockReturnValue(of({ data: names(51) }));

    const result = await service.fetchBranches(
      'https://gitlab.com',
      't',
      '42',
      {
        limit: 50,
      },
    );

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(lastParams()).toEqual({ per_page: 51, sort: 'updated_desc' });
    expect(result.branches).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated when the page is not full', async () => {
    const { http, service } = setup();
    http.get.mockReturnValue(of({ data: names(7) }));
    const result = await service.fetchBranches(
      'https://gitlab.com',
      't',
      '42',
      {
        limit: 50,
      },
    );
    expect(result).toEqual({ branches: names(7), truncated: false });
  });

  it('passes the search on to GitLab', async () => {
    const { http, service, lastParams } = setup();
    http.get.mockReturnValue(of({ data: [{ name: '1578-new-sewing' }] }));
    await service.fetchBranches('https://gitlab.com', 't', '42', {
      limit: 50,
      search: '1578',
    });
    expect(lastParams()).toEqual({
      per_page: 51,
      sort: 'updated_desc',
      search: '1578',
    });
  });

  it('checks a single branch, encoding its name', async () => {
    const { http, service } = setup();
    http.get.mockReturnValue(of({ data: { name: 'feat/x' } }));
    await expect(
      service.branchExists('https://gitlab.com', 't', '42', 'feat/x'),
    ).resolves.toBe(true);
    expect(http.get.mock.calls[0][0]).toBe(
      'https://gitlab.com/api/v4/projects/42/repository/branches/feat%2Fx',
    );
  });

  it('reports a missing branch as false, other failures as errors', async () => {
    const { http, service } = setup();
    http.get.mockReturnValueOnce(throwError(() => axiosError(404)));
    await expect(
      service.branchExists('https://gitlab.com', 't', '42', 'gone'),
    ).resolves.toBe(false);

    http.get.mockReturnValueOnce(throwError(() => axiosError(401)));
    await expect(
      service.branchExists('https://gitlab.com', 't', '42', 'main'),
    ).rejects.toMatchObject({ response: { message: 'token_invalid' } });
  });
});
