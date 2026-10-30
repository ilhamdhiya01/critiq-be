import { randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import { GithubInstallReturnTo } from '../../generated/prisma/enums';

const STATE_BYTES = 32;
const TTL_SECONDS = 10 * 60;
const KEY_PREFIX = 'github:install-verify:';

// What the Setup URL callback learned (from its single-use intent and from
// GitHub's query string), parked while the user proves through GitHub's
// OAuth web flow that the installation is theirs.
export interface PendingGithubInstallVerification {
  orgId: string;
  orgSlug: string;
  userId: string;
  returnTo: GithubInstallReturnTo;
  installationId: string;
  setupAction: 'install' | 'update';
}

// Second leg of the GitHub install round trip. Redis, not a table: it lives
// ten minutes at most, and GETDEL makes it single-use atomically.
@Injectable()
export class GithubInstallVerificationService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async begin(pending: PendingGithubInstallVerification): Promise<string> {
    const state = randomBytes(STATE_BYTES).toString('base64url');
    await this.redis.set(
      `${KEY_PREFIX}${state}`,
      JSON.stringify(pending),
      'EX',
      TTL_SECONDS,
    );
    return state;
  }

  async take(state: string): Promise<PendingGithubInstallVerification | null> {
    const raw = await this.redis.getdel(`${KEY_PREFIX}${state}`);
    return raw ? (JSON.parse(raw) as PendingGithubInstallVerification) : null;
  }
}
