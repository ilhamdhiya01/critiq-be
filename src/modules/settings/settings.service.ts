import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import { Prisma } from '../../generated/prisma/client';
import { AiProviderId, AiUsageKind, Role } from '../../generated/prisma/enums';
import { completeValidated } from '../ai/ai-call';
import { AiError, AiErrorCode, toAiError } from '../ai/ai-error';
import {
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_NAMES,
  defaultModelFor,
  toProviderEnum,
  toProviderName,
} from '../ai/ai-models.constants';
import { AiProviderFactory } from '../ai/ai-provider.factory';
import { AiProviderName } from '../ai/ai-provider.interface';
import { TEST_REQUEST } from '../ai/ai-test-fixture';
import { assertSafeBaseUrl } from '../ai/base-url-guard';
import {
  AiCredentialSummary,
  AiSettingsDto,
  AiSettingsSummaryDto,
  AiTestResultDto,
  AiTestSnapshot,
} from './dto/ai-settings.dto';
import { TestAiSettingsDto } from './dto/test-ai-settings.dto';
import { UpdateAiSettingsDto } from './dto/update-ai-settings.dto';

const TEST_LIMIT_PER_HOUR = 5;
const HOUR_SECONDS = 3600;

// What an Admin sees for each failure. Built from the code, never from the
// provider's own text, except for bad_request where the (sanitized) reason
// is the only useful information.
function userMessage(error: AiError): string {
  const status = error.status ? ` (${error.status})` : '';
  const messages: Record<AiErrorCode, string> = {
    auth_failed: `Provider rejected the API key${status}.`,
    rate_limited: `Provider rate limit reached${status}. Try again later.`,
    timeout: 'Provider did not respond in time.',
    provider_unreachable: `Provider could not be reached${status}.`,
    invalid_response:
      'Provider replied, but not with a valid structured result.',
    bad_request: `Provider rejected the request${status}: ${error.providerMessage ?? ''}`,
    insecure_base_url: error.providerMessage ?? 'Base URL is not allowed.',
    not_configured: error.providerMessage ?? 'No AI provider is configured.',
    api_key_required: 'An API key is required for this provider.',
    base_url_required: 'A base URL is required for this provider.',
  };
  return messages[error.code];
}

function unprocessable(message: string, field = 'provider'): never {
  throw new UnprocessableEntityException({ field, message });
}

function todayUtc(): Date {
  return new Date(new Date().toISOString().slice(0, 10));
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly aiProviderFactory: AiProviderFactory,
    private readonly rateLimiter: RateLimiterService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  // Full settings for an Admin; the minimal read-only view for anyone else.
  // The route's guard already checked membership; the role is re-read here
  // for this org, never taken from the token.
  async getAiForMember(
    organizationId: string,
    userId: string,
  ): Promise<AiSettingsDto | AiSettingsSummaryDto> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { role: true },
    });
    if (membership?.role === Role.ADMIN) {
      return this.getAi(organizationId);
    }
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: {
        aiProvider: true,
        aiModel: true,
        aiConsentAt: true,
        aiLocale: true,
      },
    });
    return new AiSettingsSummaryDto({
      provider: organization.aiProvider
        ? toProviderName(organization.aiProvider)
        : null,
      model: organization.aiModel,
      consent: { granted: organization.aiConsentAt !== null },
      locale: organization.aiLocale,
    });
  }

  async getAi(organizationId: string): Promise<AiSettingsDto> {
    const [organization, credentials] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: {
          aiProvider: true,
          aiModel: true,
          aiConsentAt: true,
          aiConsentUser: { select: { id: true, name: true } },
          aiLocale: true,
          aiDailyTokenBudget: true,
          aiLastTest: true,
        },
      }),
      this.prisma.aiCredential.findMany({ where: { organizationId } }),
    ]);

    const summaries = {} as Record<AiProviderName, AiCredentialSummary>;
    for (const name of AI_PROVIDER_NAMES) {
      const credential = credentials.find(
        (row) => row.provider === toProviderEnum(name),
      );
      const summary: AiCredentialSummary = {
        hasKey: Boolean(credential?.encryptedKey),
      };
      if (credential?.encryptedKey && credential.keyLast4) {
        summary.last4 = credential.keyLast4;
      }
      if (name === 'openai_compatible') {
        summary.baseUrl = credential?.baseUrl ?? null;
      }
      summaries[name] = summary;
    }

    const provider = organization.aiProvider
      ? toProviderName(organization.aiProvider)
      : null;

    return new AiSettingsDto({
      provider,
      model: organization.aiModel,
      baseUrl:
        provider === 'openai_compatible'
          ? (summaries.openai_compatible.baseUrl ?? null)
          : null,
      credentials: summaries,
      consent: organization.aiConsentAt
        ? {
            granted: true,
            at: organization.aiConsentAt,
            by: organization.aiConsentUser,
          }
        : { granted: false },
      locale: organization.aiLocale,
      dailyTokenBudget: organization.aiDailyTokenBudget,
      providers: AI_PROVIDER_CATALOG,
      lastTest: (organization.aiLastTest as AiTestSnapshot | null) ?? null,
    });
  }

  async updateAi(
    organizationId: string,
    actorUserId: string,
    dto: UpdateAiSettingsDto,
  ): Promise<AiSettingsDto> {
    if (dto.provider === 'google') {
      unprocessable('provider_unavailable');
    }

    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { aiProvider: true, aiModel: true, aiConsentAt: true },
    });
    const storedProvider = organization.aiProvider
      ? toProviderName(organization.aiProvider)
      : null;
    const provider = dto.provider ?? storedProvider;
    const providerChanged =
      dto.provider !== undefined && dto.provider !== storedProvider;

    const touchesCredential =
      (dto.apiKey !== undefined && dto.apiKey !== null) ||
      dto.baseUrl !== undefined;
    if (touchesCredential && !provider) {
      unprocessable('provider_required');
    }

    const credential = provider
      ? await this.prisma.aiCredential.findUnique({
          where: {
            organizationId_provider: {
              organizationId,
              provider: toProviderEnum(provider),
            },
          },
        })
      : null;

    // base_url only exists for openai_compatible.
    if (
      dto.baseUrl !== undefined &&
      dto.baseUrl !== null &&
      provider !== 'openai_compatible'
    ) {
      unprocessable('base_url_not_supported', 'baseUrl');
    }
    const baseUrl =
      dto.baseUrl !== undefined
        ? dto.baseUrl || null
        : (credential?.baseUrl ?? null);
    if (provider === 'openai_compatible') {
      if (
        (dto.provider !== undefined || dto.baseUrl !== undefined) &&
        !baseUrl
      ) {
        unprocessable('base_url_required', 'baseUrl');
      }
      if (dto.baseUrl) {
        try {
          await assertSafeBaseUrl(
            dto.baseUrl,
            this.aiProviderFactory.compatAllowlist(),
          );
        } catch (error) {
          unprocessable(toAiError(error).code, 'baseUrl');
        }
      }
    }

    // Selecting anthropic/openai needs a key, stored or in this request.
    // Deleting the active provider's key (apiKey: "") on its own is allowed
    // — the Admin may be about to paste a new one.
    const keyAfter =
      dto.apiKey === ''
        ? false
        : dto.apiKey
          ? true
          : Boolean(credential?.encryptedKey);
    if (
      dto.provider !== undefined &&
      provider !== 'openai_compatible' &&
      !keyAfter
    ) {
      unprocessable('api_key_required', 'apiKey');
    }

    const model =
      dto.model ??
      (providerChanged && provider
        ? defaultModelFor(provider)
        : organization.aiModel);

    const organizationData: Prisma.OrganizationUpdateInput = {};
    const changedFields: string[] = [];
    if (dto.provider !== undefined && providerChanged) {
      organizationData.aiProvider = toProviderEnum(provider!);
      changedFields.push('provider');
    }
    if (model !== organization.aiModel) {
      organizationData.aiModel = model;
      changedFields.push('model');
    }
    if (dto.locale !== undefined) {
      organizationData.aiLocale = dto.locale;
      changedFields.push('locale');
    }
    if (dto.dailyTokenBudget !== undefined) {
      organizationData.aiDailyTokenBudget = dto.dailyTokenBudget;
      changedFields.push('dailyTokenBudget');
    }

    let consentEvent: 'ai.consent_granted' | 'ai.consent_revoked' | null = null;
    if (dto.consent === true && !organization.aiConsentAt) {
      organizationData.aiConsentAt = new Date();
      organizationData.aiConsentUser = { connect: { id: actorUserId } };
      consentEvent = 'ai.consent_granted';
    } else if (dto.consent === false && organization.aiConsentAt) {
      organizationData.aiConsentAt = null;
      organizationData.aiConsentUser = { disconnect: true };
      consentEvent = 'ai.consent_revoked';
    }

    let credentialData: {
      encryptedKey?: string | null;
      keyLast4?: string | null;
      baseUrl?: string | null;
    } | null = null;
    if (provider && touchesCredential) {
      credentialData = {};
      if (dto.apiKey === '') {
        credentialData.encryptedKey = null;
        credentialData.keyLast4 = null;
        changedFields.push('apiKey');
      } else if (dto.apiKey) {
        credentialData.encryptedKey = this.encryptionService.encrypt(
          dto.apiKey,
        );
        credentialData.keyLast4 = dto.apiKey.slice(-4);
        changedFields.push('apiKey');
      }
      if (
        dto.baseUrl !== undefined &&
        baseUrl !== (credential?.baseUrl ?? null)
      ) {
        credentialData.baseUrl = baseUrl;
        changedFields.push('baseUrl');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(organizationData).length > 0) {
        await tx.organization.update({
          where: { id: organizationId },
          data: organizationData,
        });
      }
      if (provider && credentialData) {
        const providerId: AiProviderId = toProviderEnum(provider);
        await tx.aiCredential.upsert({
          where: {
            organizationId_provider: { organizationId, provider: providerId },
          },
          create: {
            organizationId,
            provider: providerId,
            encryptedKey: credentialData.encryptedKey ?? null,
            keyLast4: credentialData.keyLast4 ?? null,
            baseUrl: credentialData.baseUrl ?? baseUrl,
            updatedBy: actorUserId,
          },
          update: { ...credentialData, updatedBy: actorUserId },
        });
      }
    });

    // TODO(audit log model): persisted AuditLog rows once the table exists.
    // Field names only — never a key value.
    if (changedFields.length > 0) {
      this.logger.info('audit.ai.settings_changed', {
        orgId: organizationId,
        actorUserId,
        fields: changedFields,
      });
    }
    if (consentEvent) {
      this.logger.info(`audit.${consentEvent}`, {
        orgId: organizationId,
        by: actorUserId,
      });
    }

    return this.getAi(organizationId);
  }

  async testAi(
    organizationId: string,
    dto: TestAiSettingsDto,
  ): Promise<AiTestResultDto> {
    const allowed = await this.rateLimiter.tryConsume(
      `ratelimit:ai-test:org:${organizationId}`,
      TEST_LIMIT_PER_HOUR,
      HOUR_SECONDS,
    );
    if (!allowed) {
      throw new HttpException(
        { field: 'orgId', message: 'ai_test_rate_limited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (dto.provider === 'google') {
      unprocessable('provider_unavailable');
    }

    const startedAt = Date.now();
    let result: AiTestResultDto;
    try {
      const provider = await this.aiProviderFactory.for(organizationId, {
        provider: dto.provider,
        model: dto.model,
        baseUrl: dto.baseUrl,
        apiKey: dto.apiKey,
      });
      await provider.healthcheck();
      const completion = await completeValidated(provider, TEST_REQUEST);
      result = new AiTestResultDto({
        ok: true,
        latencyMs: Date.now() - startedAt,
        model: completion.model,
        structuredOutput: completion.structuredOutput,
        usage: completion.usage,
        error: null,
      });
      await this.recordTestUsage(organizationId, completion.usage);
    } catch (error) {
      const aiError = toAiError(error);
      this.logger.warn('ai.test_failed', {
        orgId: organizationId,
        code: aiError.code,
        status: aiError.status,
        providerMessage: aiError.providerMessage,
      });
      result = new AiTestResultDto({
        ok: false,
        latencyMs: Date.now() - startedAt,
        model: null,
        structuredOutput: 'failed',
        usage: null,
        error: { code: aiError.code, message: userMessage(aiError) },
      });
    }

    const snapshot: AiTestSnapshot = {
      at: new Date().toISOString(),
      ok: result.ok,
      latencyMs: result.latencyMs,
      structuredOutput: result.structuredOutput,
      model: result.model,
    };
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { aiLastTest: snapshot as unknown as Prisma.InputJsonValue },
    });
    return result;
  }

  // For GET /health (Checkpoint G): organizations with a provider selected.
  countConfiguredOrgs(): Promise<number> {
    return this.prisma.organization.count({
      where: { aiProvider: { not: null } },
    });
  }

  // TEST rows are recorded for visibility but never count toward
  // aiDailyTokenBudget — the budget check in step 2 reads SCAN rows only.
  private async recordTestUsage(
    organizationId: string,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    const day = todayUtc();
    await this.prisma.aiUsageDaily.upsert({
      where: {
        organizationId_day_kind: {
          organizationId,
          day,
          kind: AiUsageKind.TEST,
        },
      },
      create: {
        organizationId,
        day,
        kind: AiUsageKind.TEST,
        calls: 1,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
      update: {
        calls: { increment: 1 },
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
      },
    });
  }
}
