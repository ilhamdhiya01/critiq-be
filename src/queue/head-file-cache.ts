import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { PullsService } from '../modules/pulls/pulls.service';

const HEAD_FILE_CACHE_SECONDS = 60;

export interface HeadFileTarget {
  organizationId: string;
  repositoryId: string;
  pullId: string;
  sha: string;
}

// Head-file text per path, cached 60 s per (repo, sha, path). The static
// syntax check fetches the changed files first; the AI step of the same scan
// — usually seconds later — and a retry or regenerate right after read them
// from here instead of asking the provider again. null = not available
// (fetch failed, file too large); never cached, so the next caller retries.
export async function cachedHeadFileContents(
  redis: Redis,
  pullsService: PullsService,
  target: HeadFileTarget,
  paths: string[],
): Promise<Map<string, string | null>> {
  const keyOf = (path: string) =>
    `file:${target.repositoryId}:${target.sha}:${createHash('sha1').update(path).digest('hex')}`;
  const contents = new Map<string, string | null>();
  const missing: string[] = [];
  for (const path of paths) {
    let cached: string | null = null;
    try {
      cached = await redis.get(keyOf(path));
    } catch {
      cached = null;
    }
    if (cached !== null) {
      contents.set(path, cached);
    } else {
      missing.push(path);
    }
  }
  if (missing.length === 0) {
    return contents;
  }
  const fetched = await pullsService.getHeadFileContents(
    target.organizationId,
    target.repositoryId,
    target.pullId,
    target.sha,
    missing,
  );
  for (const [path, content] of fetched) {
    contents.set(path, content);
    if (content !== null) {
      try {
        await redis.set(keyOf(path), content, 'EX', HEAD_FILE_CACHE_SECONDS);
      } catch {
        // cache is best effort
      }
    }
  }
  return contents;
}
