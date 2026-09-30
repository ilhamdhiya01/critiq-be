import { HttpService } from '@nestjs/axios';
import axios, { AxiosError, AxiosHeaders, AxiosRequestConfig } from 'axios';
import { of, throwError } from 'rxjs';
import { GitlabApiService } from './gitlab-api.service';

// ESM-only package; the service only needs `get`, supplied below.
jest.mock('@nestjs/axios', () => ({ HttpService: class {} }));

function axiosError(status: number, data: unknown = {}): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError('failed', String(status), { headers }, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers },
    data,
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

describe('GitlabApiService.compareCommits', () => {
  const FROM = '4c2a899c92';
  const TO = '774dbae080';

  function mergeBaseCall(http: { get: jest.Mock }) {
    const call = (http.get.mock.calls as [string, AxiosRequestConfig][]).find(
      ([url]) => url.endsWith('/merge_base'),
    );
    return call!;
  }

  // MR !1780: `{ 'refs[]': … }` went out as `refs=A&refs=B` and GitLab
  // answered 400 "Provide at least 2 refs" — every incremental GitLab scan
  // failed. The URL is built with real axios here, not read off the mock.
  it('sends both refs as refs[] to merge_base', async () => {
    const { http, service } = setup();
    http.get.mockImplementation((url: string) =>
      of({
        data: url.endsWith('/merge_base') ? { id: FROM } : { diffs: [] },
      }),
    );

    await service.compareCommits('https://gitlab.com', 't', '42', FROM, TO);

    const [url, config] = mergeBaseCall(http);
    const sent = decodeURIComponent(
      axios.getUri({
        url,
        params: config.params as Record<string, unknown>,
        paramsSerializer: config.paramsSerializer,
      }),
    );
    expect(sent).toBe(
      `https://gitlab.com/api/v4/projects/42/repository/merge_base?refs[]=${FROM}&refs[]=${TO}`,
    );
  });

  it('reports whether the previous head is an ancestor', async () => {
    const { http, service } = setup();
    const respond = (base: string) => (url: string) =>
      of({
        data: url.endsWith('/merge_base')
          ? { id: base }
          : { diffs: [{ new_path: 'a.ts' }] },
      });

    http.get.mockImplementation(respond(FROM));
    await expect(
      service.compareCommits('https://gitlab.com', 't', '42', FROM, TO),
    ).resolves.toMatchObject({ ancestor: true, diffs: [{ new_path: 'a.ts' }] });

    // Force-push: the merge base is some older commit.
    http.get.mockImplementation(respond('0000000000'));
    await expect(
      service.compareCommits('https://gitlab.com', 't', '42', FROM, TO),
    ).resolves.toMatchObject({ ancestor: false });
  });
});

describe('GitlabApiService.mapGitlabRequestError', () => {
  const { service } = setup();
  const mapped = (error: unknown) => {
    try {
      service.mapGitlabRequestError(error);
    } catch (thrown) {
      return (thrown as { getResponse(): unknown }).getResponse();
    }
  };

  // A refused request is not an unreachable instance: it fails the scan
  // at once (PROVIDER_REJECTED) instead of three retries.
  it('maps 400 to provider_bad_request, carrying GitLab reason', () => {
    expect(
      mapped(axiosError(400, { message: 'Provide at least 2 refs' })),
    ).toEqual({
      field: 'request',
      message: 'provider_bad_request',
      detail: '"Provide at least 2 refs"',
    });
  });

  it('keeps 401 as token_invalid and 404 as instance_unreachable', () => {
    expect(mapped(axiosError(401))).toMatchObject({ message: 'token_invalid' });
    // A wrong instance URL at connect time answers 404 — that contract stays.
    expect(mapped(axiosError(404))).toMatchObject({
      message: 'instance_unreachable',
    });
  });
});
