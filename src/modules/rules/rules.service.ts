import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { FindingCategory, RuleTier } from '../../generated/prisma/enums';
import {
  AI_ONLY_TIERS,
  ALL_RULE_TIERS,
  tierForCategory,
  tierForRule,
} from '../../queue/rules/rule-tiers';
import { FILE_RULE_IDS, RULES } from '../../queue/rules/rules';
import { AI_CATEGORIES, TIER_CHECKS } from '../ai/scan/ai-prompt.constants';
import { toApiRuleTier } from '../scans/dto/ai-scan-fields';
import { RulesDto, RuleTierDto, RuleTierEngine } from './dto/rules.dto';

const STATIC_RULE_IDS = [...RULES.map((rule) => rule.id), ...FILE_RULE_IDS];

function engineOf(tier: RuleTier, hasStatic: boolean): RuleTierEngine {
  const hasAi = TIER_CHECKS[tier] !== null;
  return hasStatic && hasAi ? 'static+ai' : hasStatic ? 'static' : 'ai';
}

// What each tier contains never changes at runtime: built once.
const CATALOG = ALL_RULE_TIERS.map((tier) => {
  const staticRules = STATIC_RULE_IDS.filter((id) => tierForRule(id) === tier);
  return {
    tier,
    id: toApiRuleTier(tier),
    engine: engineOf(tier, staticRules.length > 0),
    requiresAi: AI_ONLY_TIERS.includes(tier),
    staticRules,
    aiCategories: AI_CATEGORIES.filter(
      (category) =>
        tierForCategory(category.toUpperCase() as FindingCategory) === tier,
    ),
  };
});

@Injectable()
export class RulesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly realtime: RealtimePublisher,
  ) {}

  async get(organizationId: string): Promise<RulesDto> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        disabledRuleTiers: true,
        ruleTiersUpdatedAt: true,
        ruleTiersUpdatedBy: true,
      },
    });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }
    const tiers: RuleTierDto[] = CATALOG.map(({ tier, ...entry }) => ({
      ...entry,
      enabled: !organization.disabledRuleTiers.includes(tier),
    }));
    return {
      tiers,
      enabledCount: tiers.filter((tier) => tier.enabled).length,
      totalCount: tiers.length,
      updatedAt: organization.ruleTiersUpdatedAt?.toISOString() ?? null,
      updatedBy: organization.ruleTiersUpdatedBy,
    };
  }

  // Open PRs are not rescanned here: their next push runs in full under the
  // new profile (FullReason.RULES_CHANGED).
  async setTier(
    organizationId: string,
    actor: { userId: string; role: string },
    tier: RuleTier,
    enabled: boolean,
  ): Promise<RulesDto> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { disabledRuleTiers: true },
    });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }
    const wasEnabled = !organization.disabledRuleTiers.includes(tier);
    if (wasEnabled !== enabled) {
      const disabledRuleTiers = enabled
        ? organization.disabledRuleTiers.filter((t) => t !== tier)
        : [...organization.disabledRuleTiers, tier];
      await this.prisma.organization.update({
        where: { id: organizationId },
        data: {
          disabledRuleTiers,
          ruleTiersUpdatedAt: new Date(),
          ruleTiersUpdatedBy: actor.userId,
        },
      });
      // TODO(audit log model): persisted AuditLog rows once the table exists.
      this.logger.info('audit.rules.tier_changed', {
        orgId: organizationId,
        actorUserId: actor.userId,
        role: actor.role,
        tier,
        enabled,
      });
      await this.realtime.publish({
        type: 'settings.updated',
        orgId: organizationId,
        area: 'rules',
      });
    }
    return this.get(organizationId);
  }
}
