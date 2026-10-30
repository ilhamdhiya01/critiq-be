import { HttpStatus, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { SlugService } from '../../common/slug/slug.service';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import { Role } from '../../generated/prisma/enums';
import { OrganizationsService } from './organizations.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../common/realtime/realtime.publisher', () => ({
  RealtimePublisher: class {},
}));
jest.mock('../../common/slug/slug.service', () => ({ SlugService: class {} }));
jest.mock('../../common/redis/rate-limiter.service', () => ({
  RateLimiterService: class {},
}));

const USER = 'user_1';
const ORG = 'org_1';

// `existing`: the org `update` finds, null when it does not exist.
function setup(existing: { id: string } | null = { id: ORG }) {
  // Records the order of side effects: commit first, then publish.
  const events: string[] = [];
  const tx = {
    organization: {
      create: jest.fn(({ data }: { data: object }) =>
        Promise.resolve({ id: ORG, ...data }),
      ),
      findUnique: jest.fn().mockResolvedValue(existing),
      update: jest.fn(({ data }: { data: object }) =>
        Promise.resolve({ id: ORG, ...data }),
      ),
    },
    membership: {
      create: jest.fn(({ data }: { data: object }) => Promise.resolve(data)),
    },
    integration: { create: jest.fn(), upsert: jest.fn() },
  };
  const prisma = {
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (run: (client: typeof tx) => unknown) => {
      const result = await run(tx);
      events.push('commit');
      return result;
    }),
  };
  const slugs = {
    generateUniqueOrgSlug: jest.fn().mockResolvedValue('acme'),
  };
  const realtime = {
    publish: jest.fn(() => {
      events.push('publish');
      return Promise.resolve();
    }),
  };
  const rateLimiter = { tryConsume: jest.fn().mockResolvedValue(true) };
  const service = new OrganizationsService(
    prisma as unknown as PrismaService,
    slugs as unknown as SlugService,
    realtime as unknown as RealtimePublisher,
    rateLimiter as unknown as RateLimiterService,
  );
  return { service, prisma, tx, slugs, realtime, events, rateLimiter };
}

describe('OrganizationsService', () => {
  describe('listForUser', () => {
    it('lists only active memberships, oldest first', async () => {
      const { service, prisma } = setup();
      await service.listForUser(USER);
      expect(prisma.membership.findMany).toHaveBeenCalledWith({
        where: { userId: USER, status: 'ACTIVE' },
        include: { organization: true },
        orderBy: { createdAt: 'asc' },
      });
    });
  });

  describe('create', () => {
    it('is limited per user: 429 org_create_rate_limited', async () => {
      const { service, prisma, rateLimiter } = setup();
      rateLimiter.tryConsume.mockResolvedValue(false);
      await expect(
        service.create(USER, { name: 'Acme' }),
      ).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: { message: 'org_create_rate_limited' },
      });
      expect(rateLimiter.tryConsume).toHaveBeenCalledWith(
        `ratelimit:org-create:user:${USER}`,
        10,
        3600,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('makes the creator its active Admin', async () => {
      const { service, tx } = setup();
      const result = await service.create(USER, { name: 'Acme' });
      expect(result.role).toBe(Role.ADMIN);
      expect(result.organization).toMatchObject({
        name: 'Acme',
        slug: 'acme',
        createdBy: USER,
      });
      expect(tx.membership.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: USER,
          organizationId: ORG,
          role: Role.ADMIN,
          status: 'ACTIVE',
        }) as object,
      });
    });

    // PRD v1.4/D3: an org always starts without a code host connection.
    it('never connects an integration on its own', async () => {
      const { service, tx } = setup();
      await service.create(USER, { name: 'Acme' });
      expect(tx.integration.create).not.toHaveBeenCalled();
      expect(tx.integration.upsert).not.toHaveBeenCalled();
    });

    it('derives the slug inside the same transaction', async () => {
      const { service, tx, slugs } = setup();
      await service.create(USER, { name: 'Acme' });
      expect(slugs.generateUniqueOrgSlug).toHaveBeenCalledWith(tx, 'Acme');
    });
  });

  describe('update', () => {
    it('renames the org with a fresh slug that ignores its own', async () => {
      const { service, tx, slugs } = setup();
      await expect(service.update(ORG, { name: 'Acme' })).resolves.toEqual({
        id: ORG,
        name: 'Acme',
        slug: 'acme',
      });
      expect(slugs.generateUniqueOrgSlug).toHaveBeenCalledWith(tx, 'Acme', ORG);
    });

    // CLAUDE.md "Realtime": publish after commit, never inside it.
    it('tells open tabs only after the rename is committed', async () => {
      const { service, realtime, events } = setup();
      await service.update(ORG, { name: 'Acme' });
      expect(events).toEqual(['commit', 'publish']);
      expect(realtime.publish).toHaveBeenCalledWith({
        type: 'settings.updated',
        orgId: ORG,
        area: 'organization',
      });
    });

    it('404s for an unknown org and announces nothing', async () => {
      const { service, tx, realtime } = setup(null);
      await expect(service.update(ORG, { name: 'Acme' })).rejects.toThrow(
        NotFoundException,
      );
      expect(tx.organization.update).not.toHaveBeenCalled();
      expect(realtime.publish).not.toHaveBeenCalled();
    });
  });
});
