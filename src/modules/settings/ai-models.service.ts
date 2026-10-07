import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';
import { AiErrorCode, toAiError } from '../ai/ai-error';
import {
  AI_PROVIDER_CATALOG,
  RECOMMENDED_MODELS,
  toProviderEnum,
} from '../ai/ai-models.constants';
import {
  AiProviderFactory,
  AiProviderOverride,
} from '../ai/ai-provider.factory';
import { AiModelInfo, AiProviderName } from '../ai/ai-provider.interface';
import { aiErrorMessage } from './ai-error-message';
import { AiModelsDto, PreviewAiModelsDto } from './dto/ai-models.dto';

const CACHE_TTL_SECONDS = 3600;
// The preview takes any key the caller types, so it is limited like the
// test connection, if more loosely (it is one cheap call, not a review).
const PREVIEW_LIMIT_PER_HOUR = 20;
const HOUR_SECONDS = 3600;
// Wrong input, not an unreachable provider: answered 422 rather than
// falling back to the catalog.
const INPUT_ERRORS: readonly AiErrorCode[] = [
  'insecure_base_url',
  'base_url_required',
];

type ProviderParam = AiProviderName | 'google';

// Newest first where the provider dates its models (Anthropic, OpenAI);
// undated ones after, in the provider's own order.
function newestFirst(models: AiModelInfo[]): AiModelInfo[] {
  const dated = models.filter((model) => model.createdAt !== null);
  const undated = models.filter((model) => model.createdAt === null);
  dated.sort((a, b) => b.createdAt!.getTime() - a.createdAt!.getTime());
  return [...dated, ...undated];
}

// What the picker shows when the provider cannot be asked: the catalog's
// suggestions, or for openai_compatible (no catalog models) the
// recommended ones.
function catalogModels(provider: AiProviderName): AiModelInfo[] {
  const entry = AI_PROVIDER_CATALOG.find((item) => item.id === provider);
  const ids = entry?.models?.length
    ? entry.models
    : RECOMMENDED_MODELS[provider];
  return ids.map((id) => ({
    id,
    label: id,
    contextWindow: null,
    createdAt: null,
  }));
}

// Models for the Settings → AI Provider picker, asked from the provider
// itself with the organization's key — the catalog in code only suggests,
// and goes stale with every model release.
@Injectable()
export class AiModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiProviderFactory: AiProviderFactory,
    private readonly rateLimiter: RateLimiterService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  // With the stored key. Cached an hour per credential: the key's
  // updatedAt is part of the cache key, so replacing the key (or base URL)
  // asks the provider again at once.
  async listForOrg(
    organizationId: string,
    provider: ProviderParam,
  ): Promise<AiModelsDto> {
    const name = this.availableOrThrow(provider);
    const credential = await this.prisma.aiCredential.findUnique({
      where: {
        organizationId_provider: {
          organizationId,
          provider: toProviderEnum(name),
        },
      },
      select: { updatedAt: true },
    });
    const cacheKey = `ai:models:${organizationId}:${name}:${credential?.updatedAt.getTime() ?? 'none'}`;

    const cached = await this.readCache(cacheKey);
    if (cached) {
      return cached;
    }
    const result = await this.fetch(organizationId, name, {});
    // Only a live answer is cached; a fallback retries on the next open.
    if (result.source === 'live') {
      await this.writeCache(cacheKey, result);
    }
    return result;
  }

  // With a key/base URL typed in the form, before saving. Not cached —
  // the key is not the stored one — and nothing is persisted.
  async preview(
    organizationId: string,
    dto: PreviewAiModelsDto,
  ): Promise<AiModelsDto> {
    const name = this.availableOrThrow(dto.provider);
    const allowed = await this.rateLimiter.tryConsume(
      `ratelimit:ai-models:org:${organizationId}`,
      PREVIEW_LIMIT_PER_HOUR,
      HOUR_SECONDS,
    );
    if (!allowed) {
      throw new HttpException(
        { field: 'orgId', message: 'ai_models_rate_limited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.fetch(organizationId, name, {
      apiKey: dto.apiKey,
      baseUrl: dto.baseUrl,
    });
  }

  private availableOrThrow(provider: ProviderParam): AiProviderName {
    if (provider === 'google') {
      throw new UnprocessableEntityException({
        field: 'provider',
        message: 'provider_unavailable',
      });
    }
    return provider;
  }

  private async fetch(
    organizationId: string,
    provider: AiProviderName,
    override: Pick<AiProviderOverride, 'apiKey' | 'baseUrl'>,
  ): Promise<AiModelsDto> {
    try {
      const adapter = await this.aiProviderFactory.forModelListing(
        organizationId,
        { provider, ...override },
      );
      const models = await adapter.listModels();
      return this.toDto(provider, 'live', newestFirst(models), null);
    } catch (error) {
      const aiError = toAiError(error);
      if (INPUT_ERRORS.includes(aiError.code)) {
        throw new UnprocessableEntityException({
          field: 'baseUrl',
          message: aiError.code,
        });
      }
      this.logger.warn('ai.models_list_failed', {
        orgId: organizationId,
        provider,
        code: aiError.code,
        status: aiError.status,
      });
      return this.toDto(provider, 'catalog', catalogModels(provider), {
        code: aiError.code,
        message: aiErrorMessage(aiError),
      });
    }
  }

  private toDto(
    provider: AiProviderName,
    source: AiModelsDto['source'],
    models: AiModelInfo[],
    warning: AiModelsDto['warning'],
  ): AiModelsDto {
    const recommended = new Set(RECOMMENDED_MODELS[provider]);
    return new AiModelsDto({
      provider,
      source,
      fetchedAt: new Date().toISOString(),
      warning,
      models: models.map((model) => ({
        id: model.id,
        label: model.label,
        contextWindow: model.contextWindow,
        recommended: recommended.has(model.id),
      })),
    });
  }

  // Cache failures never fail the request — the provider is asked instead.
  private async readCache(key: string): Promise<AiModelsDto | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? new AiModelsDto(JSON.parse(raw) as AiModelsDto) : null;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, value: AiModelsDto): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
    } catch {
      this.logger.warn('ai.models_cache_write_failed', { key });
    }
  }
}
