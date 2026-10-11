import { NotFoundException } from '@nestjs/common';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Role, RuleTier } from '../../generated/prisma/enums';
import { RulesService } from './rules.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));

function setup(disabledRuleTiers: RuleTier[] | null) {
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue(
        disabledRuleTiers && {
          disabledRuleTiers,
          ruleTiersUpdatedAt: null,
          ruleTiersUpdatedBy: null,
        },
      ),
      update: jest.fn(),
    },
  };
  const logger = { info: jest.fn() };
  const service = new RulesService(
    prisma as unknown as PrismaService,
    logger as unknown as Logger,
  );
  return { service, prisma, logger };
}

describe('RulesService', () => {
  it('lists all seven tiers, on by default, with how each is checked', async () => {
    const { service } = setup([]);
    const rules = await service.get('org_1');

    expect(rules.enabledCount).toBe(7);
    expect(rules.tiers.map((tier) => [tier.id, tier.engine])).toEqual([
      ['secrets', 'static+ai'],
      ['crash', 'static+ai'],
      ['breaking_change', 'ai'],
      ['error_handling', 'static+ai'],
      ['performance', 'ai'],
      ['security', 'static+ai'],
      ['ci', 'ci'],
    ]);
    const security = rules.tiers.find((tier) => tier.id === 'security')!;
    expect(security.staticRules).toContain('code.insecure_tls');
    expect(security.aiCategories).toContain('injection');
    expect(
      rules.tiers.filter((tier) => tier.requiresAi).map((tier) => tier.id),
    ).toEqual(['breaking_change', 'performance']);
  });

  it('turns a tier off and records who did it', async () => {
    const { service, prisma, logger } = setup([]);
    await service.setTier(
      'org_1',
      { userId: 'user_1', role: Role.ADMIN },
      RuleTier.PERFORMANCE,
      false,
    );

    const [update] = prisma.organization.update.mock.calls[0] as [
      { where: unknown; data: Record<string, unknown> },
    ];
    expect(update.where).toEqual({ id: 'org_1' });
    expect(update.data).toMatchObject({
      disabledRuleTiers: [RuleTier.PERFORMANCE],
      ruleTiersUpdatedBy: 'user_1',
    });
    expect(logger.info).toHaveBeenCalledWith(
      'audit.rules.tier_changed',
      expect.objectContaining({ tier: RuleTier.PERFORMANCE, enabled: false }),
    );
  });

  it('writes nothing when the tier is already in that state', async () => {
    const { service, prisma, logger } = setup([RuleTier.CI]);
    await service.setTier(
      'org_1',
      { userId: 'user_1', role: Role.ADMIN },
      RuleTier.CI,
      false,
    );

    expect(prisma.organization.update).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown organization', async () => {
    const { service } = setup(null);
    await expect(service.get('org_x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
