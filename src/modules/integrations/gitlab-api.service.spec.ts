import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios, {
  AxiosError,
  AxiosHeaders,
  AxiosRequestConfig,
  InternalAxiosRequestConfig,
} from 'axios';
import { of, throwError } from 'rxjs';
import { UnsafeUrlError } from '../../common/net/safe-url';
import { GitlabApiService, gitlabOutboundGuard } from './gitlab-api.service';

// ESM-only package; the service only needs `get`, supplied below.
jest.mock('@nestjs/axios', () => ({ HttpService: class {} }));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));

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
  const http = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    axiosRef: { interceptors: { request: { use: jest.fn() } } },
  };
  const service = new GitlabApiService(
    http as unknown as HttpService,
    { get: () => [] } as unknown as ConfigService,
  );
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

// Display only: GitLab returns { language: percentage }; the top one wins,
// and any failure is null rather than an error for the caller.
describe('GitlabApiService.fetchMainLanguage', () => {
  it('picks the language with the highest share', async () => {
    const { http, service } = setup();
    http.get.mockReturnValue(
      of({ data: { CSS: 12.5, PHP: 80.1, Blade: 7.4 } }),
    );
    await expect(
      service.fetchMainLanguage('https://gitlab.com', 'token', '42'),
    ).resolves.toBe('PHP');
    expect(http.get).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/42/languages',
      expect.anything(),
    );
  });

  it('is null for a project without detected languages', async () => {
    const { http, service } = setup();
    http.get.mockReturnValue(of({ data: {} }));
    await expect(
      service.fetchMainLanguage('https://gitlab.com', 'token', '42'),
    ).resolves.toBeNull();
  });

  it('is null when GitLab fails', async () => {
    const { http, service } = setup();
    http.get.mockReturnValue(throwError(() => axiosError(403)));
    await expect(
      service.fetchMainLanguage('https://gitlab.com', 'token', '42'),
    ).resolves.toBeNull();
  });
});

// v1.5.2: a review decision copied to GitLab as the org token's user.
describe('GitlabApiService review calls', () => {
  const approve = (service: GitlabApiService) =>
    service.approveMergeRequest(
      'https://gitlab.com',
      'token',
      '42',
      '7',
      'abc123',
    );

  it('approves pinned to the sha', async () => {
    const { http, service } = setup();
    http.post.mockReturnValue(of({ data: {} }));
    await approve(service);
    expect(http.post).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/42/merge_requests/7/approve',
      { sha: 'abc123' },
      expect.anything(),
    );
  });

  // Two Critiq reviewers approving in turn: the token already approved.
  it('treats an approval that is already there as done', async () => {
    const { http, service } = setup();
    http.post.mockReturnValue(throwError(() => axiosError(401)));
    http.get.mockReturnValue(of({ data: { user_has_approved: true } }));
    await expect(approve(service)).resolves.toBeUndefined();
  });

  it.each([
    [401, 'not_allowed', false],
    [409, 'head_changed', false],
    [403, 'insufficient_permission', false],
    [502, 'provider_unreachable', true],
  ])('maps %i to %s', async (status, code, retryable) => {
    const { http, service } = setup();
    http.post.mockReturnValue(throwError(() => axiosError(status)));
    http.get.mockReturnValue(of({ data: { user_has_approved: false } }));
    await expect(approve(service)).rejects.toMatchObject({ code, retryable });
  });

  it('treats unapproving an MR it had not approved as done', async () => {
    const { http, service } = setup();
    http.post.mockReturnValue(throwError(() => axiosError(404)));
    await expect(
      service.unapproveMergeRequest('https://gitlab.com', 'token', '42', '7'),
    ).resolves.toBeUndefined();
  });
});

// v1.5.2: merging from Critiq as the org token's user.
describe('GitlabApiService.mergeMergeRequest', () => {
  const merge = (service: GitlabApiService) =>
    service.mergeMergeRequest('https://gitlab.com', 'token', '42', '7', {
      sha: 'abc123',
      squash: true,
      removeSourceBranch: true,
    });

  it('merges pinned to the sha with the chosen flags', async () => {
    const { http, service } = setup();
    http.put.mockReturnValue(of({ data: {} }));
    await merge(service);
    expect(http.put).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/42/merge_requests/7/merge',
      { sha: 'abc123', squash: true, should_remove_source_branch: true },
      expect.anything(),
    );
  });

  it.each([
    [409, 'head_changed'],
    [405, 'not_mergeable'],
    [406, 'not_mergeable'],
    [401, 'insufficient_permission'],
    [500, 'provider_unreachable'],
  ])('maps %i to %s', async (status, code) => {
    const { http, service } = setup();
    http.put.mockReturnValue(throwError(() => axiosError(status)));
    await expect(merge(service)).rejects.toMatchObject({ code });
  });
});

// v1.5.2: comments as the org token's user.
describe('GitlabApiService comments', () => {
  const position = {
    base_sha: 'b',
    start_sha: 's',
    head_sha: 'h',
    position_type: 'text' as const,
    old_path: 'a.ts',
    new_path: 'a.ts',
    new_line: 9,
  };

  it('starts an inline discussion with its position', async () => {
    const { http, service } = setup();
    http.post.mockReturnValue(of({ data: { id: 'd1', notes: [{ id: 55 }] } }));
    await expect(
      service.createDiscussion(
        'https://gitlab.com',
        'token',
        '42',
        '7',
        'nit',
        position,
      ),
    ).resolves.toEqual({ discussionId: 'd1', noteId: 55 });
    expect(http.post).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/42/merge_requests/7/discussions',
      { body: 'nit', position },
      expect.anything(),
    );
  });

  it('maps a position GitLab cannot place to invalid_position', async () => {
    const { http, service } = setup();
    http.post.mockReturnValue(throwError(() => axiosError(400)));
    await expect(
      service.createDiscussion(
        'https://gitlab.com',
        'token',
        '42',
        '7',
        'nit',
        position,
      ),
    ).rejects.toMatchObject({ code: 'invalid_position', retryable: false });
  });

  it('turns on note events for an existing hook', async () => {
    const { http, service } = setup();
    http.put.mockReturnValue(of({ data: {} }));
    await service.enableNoteEvents(
      'https://gitlab.com',
      'token',
      '42',
      5,
      'https://be/hook',
    );
    expect(http.put).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/42/hooks/5',
      expect.objectContaining({ note_events: true, url: 'https://be/hook' }),
      expect.anything(),
    );
  });
});

// The Instance URL is typed in by a tenant's Admin: every request to it is
// checked, so it cannot reach Critiq's own network (SSRF).
describe('gitlabOutboundGuard', () => {
  const lookup = (hostname: string) =>
    Promise.resolve(
      {
        'gitlab.example.com': [{ address: '203.0.113.10', family: 4 }],
        'internal.example.com': [{ address: '10.0.0.5', family: 4 }],
        'gitlab.corp': [{ address: '10.0.0.6', family: 4 }],
      }[hostname] ?? [],
    );
  const request = (url: string) =>
    ({ url, headers: new AxiosHeaders() }) as InternalAxiosRequestConfig;

  it('lets a public https instance through without following redirects', async () => {
    const config = await gitlabOutboundGuard(
      [],
      lookup,
    )(request('https://gitlab.example.com/api/v4/user'));
    expect(config.maxRedirects).toBe(0);
  });

  it.each([
    'http://gitlab.example.com/api/v4/user',
    'https://127.0.0.1/api/v4/user',
    'https://169.254.169.254/latest/meta-data',
    'https://internal.example.com/api/v4/user',
    'https://user:pass@gitlab.example.com/api/v4/user',
  ])('refuses %s', async (url) => {
    await expect(
      gitlabOutboundGuard([], lookup)(request(url)),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('lets an allowlisted internal host through', async () => {
    await expect(
      gitlabOutboundGuard(
        ['gitlab.corp'],
        lookup,
      )(request('http://gitlab.corp/api/v4/user')),
    ).resolves.toBeDefined();
  });

  it('is registered on the service axios instance', () => {
    const { http } = setup();
    expect(http.axiosRef.interceptors.request.use).toHaveBeenCalledTimes(1);
  });

  it('answers 422 insecure_instance_url', () => {
    const { service } = setup();
    expect(() =>
      service.mapGitlabRequestError(new UnsafeUrlError('URL must use https.')),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          message: 'insecure_instance_url',
        }) as unknown,
      }) as Error,
    );
  });
});
