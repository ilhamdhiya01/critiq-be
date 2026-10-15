import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GithubInstallReturnTo } from '../../generated/prisma/enums';

const STATE_BYTES = 32;
const INTENT_TTL_MINUTES = 10;

export interface GithubInstallIntentPayload {
  orgId: string;
  userId: string;
  returnTo: GithubInstallReturnTo;
}

// What the callback gets back: the FE's org routes are by slug
// (`/<slug>/settings`), not by id.
export interface ConsumedGithubInstallIntent extends GithubInstallIntentPayload {
  orgSlug: string;
}

// Bridges the GitHub App installation redirect round trip (Critiq ->
// github.com -> Critiq callback) via a single-use, TTL'd Postgres row —
// not a signed JWT (the previous approach): a JWT `state` param can't be
// invalidated after one use (anyone who captures the URL, e.g. from
// browser history or a referrer header, could replay it), and can't carry
// a server-verifiable "already consumed" fact. A DB row can be deleted on
// first read, closing that window entirely.
@Injectable()
export class GithubInstallIntentService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    payload: GithubInstallIntentPayload,
  ): Promise<{ state: string }> {
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + INTENT_TTL_MINUTES * 60 * 1000);

    await this.prisma.githubInstallIntent.create({
      data: {
        state,
        organizationId: payload.orgId,
        userId: payload.userId,
        returnTo: payload.returnTo,
        expiresAt,
      },
    });

    return { state };
  }

  // Single-use: the row is deleted as part of this call (whether found or
  // not), so a replayed/reused `state` value can never succeed twice, even
  // if it hasn't technically expired yet. The org's slug is read from the
  // DB here — the callback is unauthenticated, so it never comes from the
  // request — and an intent whose organization is gone is treated as
  // invalid.
  async consume(state: string): Promise<ConsumedGithubInstallIntent | null> {
    const intent = await this.prisma.githubInstallIntent.findUnique({
      where: { state },
    });

    if (!intent) {
      return null;
    }

    await this.prisma.githubInstallIntent.delete({ where: { state } });

    if (intent.expiresAt.getTime() < Date.now()) {
      return null;
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: intent.organizationId },
      select: { slug: true },
    });
    if (!organization) {
      return null;
    }

    return {
      orgId: intent.organizationId,
      orgSlug: organization.slug,
      userId: intent.userId,
      returnTo: intent.returnTo,
    };
  }
}
