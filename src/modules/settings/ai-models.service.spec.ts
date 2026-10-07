import { UnprocessableEntityException } from '@nestjs/common';
import type Redis from 'ioredis';
import { Logger } from 'winston';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import { AiError } from '../ai/ai-error';
import { AiProviderFactory } from '../ai/ai-provider.factory';
import { AiModelInfo } from '../ai/ai-provider.interface';
import { AiModelsService } from './ai-models.service';

jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../common/redis/rate-limiter.service', () => ({
  RateLimiterService: class {},
}));
jest.mock('../ai/ai-provider.factory', () => ({ AiProviderFactory: class {} }));

const ORG = 'org_1';
const UPDATED = new Date('2026-10-07T01:00:00Z');

const model = (id: string, created: string | null): AiModelInfo => ({
  id,
  label: id,
  contextWindow: null,
  createdAt: created ? new Date(created) : null,
});

function setup(options: { credential?: { updatedAt: Date } | null } = {}) {
  const adapter = { listModels: jest.fn() };
  const factory = { forModelListing: jest.fn().mockResolvedValue(adapter) };
  const prisma = {
    aiCredential: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.credential === undefined
            ? { updatedAt: UPDATED }
            : options.credential,
        ),
    },
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
  const rateLimiter = { tryConsume: jest.fn().mockResolvedValue(true) };
  const logger = { warn: jest.fn(), info: jest.fn() };
  const service = new AiModelsService(
    prisma as unknown as PrismaService,
    factory as unknown as AiProviderFactory,
    rateLimiter as unknown as RateLimiterService,
    redis as unknown as Redis,
    logger as unknown as Logger,
  );
  return { service, adapter, factory, redis, rateLimiter };
}

describe('AiModelsService.listForOrg', () => {
  it('asks the provider and orders newest first, undated last', async () => {
    const { service, adapter, factory } = setup();
    adapter.listModels.mockResolvedValue([
      model('gpt-4o-mini', '2024-07-18T00:00:00Z'),
      model('custom-gateway-model', null),
      model('gpt-4.1', '2025-04-14T00:00:00Z'),
    ]);

    const result = await service.listForOrg(ORG, 'openai');

    expect(factory.forModelListing).toHaveBeenCalledWith(ORG, {
      provider: 'openai',
    });
    expect(result).toMatchObject({
      provider: 'openai',
      source: 'live',
      warning: null,
    });
    expect(result.models).toEqual([
      {
        id: 'gpt-4.1',
        label: 'gpt-4.1',
        contextWindow: null,
        recommended: false,
      },
      {
        id: 'gpt-4o-mini',
        label: 'gpt-4o-mini',
        contextWindow: null,
        recommended: true,
      },
      {
        id: 'custom-gateway-model',
        label: 'custom-gateway-model',
        contextWindow: null,
        recommended: false,
      },
    ]);
  });

  it('caches a live answer per credential, for an hour', async () => {
    const { service, adapter, redis } = setup();
    adapter.listModels.mockResolvedValue([model('gpt-4o', null)]);

    await service.listForOrg(ORG, 'openai');

    expect(redis.get).toHaveBeenCalledWith(
      `ai:models:${ORG}:openai:${UPDATED.getTime()}`,
    );
    expect(redis.set).toHaveBeenCalledWith(
      `ai:models:${ORG}:openai:${UPDATED.getTime()}`,
      expect.any(String),
      'EX',
      3600,
    );
  });

  it('serves the cache without asking the provider', async () => {
    const { service, redis, factory } = setup();
    redis.get.mockResolvedValue(
      JSON.stringify({
        provider: 'openai',
        source: 'live',
        fetchedAt: '2026-10-07T00:00:00.000Z',
        warning: null,
        models: [
          {
            id: 'gpt-4o',
            label: 'gpt-4o',
            contextWindow: null,
            recommended: true,
          },
        ],
      }),
    );

    const result = await service.listForOrg(ORG, 'openai');

    expect(result.fetchedAt).toBe('2026-10-07T00:00:00.000Z');
    expect(factory.forModelListing).not.toHaveBeenCalled();
  });

  // No key yet: the picker still has something to offer.
  it('falls back to the catalog with a warning, without caching it', async () => {
    const { service, factory, redis } = setup({ credential: null });
    factory.forModelListing.mockRejectedValue(new AiError('api_key_required'));

    const result = await service.listForOrg(ORG, 'anthropic');

    expect(redis.get).toHaveBeenCalledWith(`ai:models:${ORG}:anthropic:none`);
    expect(result).toMatchObject({
      source: 'catalog',
      warning: {
        code: 'api_key_required',
        message: 'An API key is required for this provider.',
      },
    });
    expect(result.models.map((m) => m.id)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5-5',
      'claude-haiku-4-5-20251001',
    ]);
    expect(result.models.every((m) => m.recommended)).toBe(true);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('falls back when the provider refuses the key', async () => {
    const { service, adapter } = setup();
    adapter.listModels.mockRejectedValue(
      new AiError('auth_failed', { status: 401 }),
    );

    const result = await service.listForOrg(ORG, 'openai_compatible');

    expect(result.source).toBe('catalog');
    expect(result.warning?.code).toBe('auth_failed');
    // No catalog models for a gateway: the recommended ones instead.
    expect(result.models[0]).toMatchObject({
      id: 'gpt-4o-mini',
      recommended: true,
    });
  });

  it('answers 422 for a base URL that is not allowed', async () => {
    const { service, factory } = setup();
    factory.forModelListing.mockRejectedValue(
      new AiError('insecure_base_url', { providerMessage: 'Private address.' }),
    );
    await expect(
      service.listForOrg(ORG, 'openai_compatible'),
    ).rejects.toMatchObject({
      response: { field: 'baseUrl', message: 'insecure_base_url' },
    });
  });

  it('answers 422 provider_unavailable for google', async () => {
    const { service, factory } = setup();
    await expect(service.listForOrg(ORG, 'google')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(factory.forModelListing).not.toHaveBeenCalled();
  });

  it('still answers when Redis is down', async () => {
    const { service, adapter, redis } = setup();
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    adapter.listModels.mockResolvedValue([model('gpt-4o', null)]);

    await expect(service.listForOrg(ORG, 'openai')).resolves.toMatchObject({
      source: 'live',
    });
  });
});

describe('AiModelsService.preview', () => {
  it('uses the typed key and base URL, without the cache', async () => {
    const { service, adapter, factory, redis } = setup();
    adapter.listModels.mockResolvedValue([model('gpt-4o-mini', null)]);

    const result = await service.preview(ORG, {
      provider: 'openai_compatible',
      apiKey: 'sk-typed-in-the-form-000000',
      baseUrl: 'https://ai.example.com/v1',
    });

    expect(factory.forModelListing).toHaveBeenCalledWith(ORG, {
      provider: 'openai_compatible',
      apiKey: 'sk-typed-in-the-form-000000',
      baseUrl: 'https://ai.example.com/v1',
    });
    expect(result.source).toBe('live');
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('is limited to 20 an hour per organization', async () => {
    const { service, rateLimiter, factory } = setup();
    rateLimiter.tryConsume.mockResolvedValue(false);

    await expect(
      service.preview(ORG, { provider: 'openai' }),
    ).rejects.toMatchObject({
      status: 429,
      response: { message: 'ai_models_rate_limited' },
    });
    expect(rateLimiter.tryConsume).toHaveBeenCalledWith(
      `ratelimit:ai-models:org:${ORG}`,
      20,
      3600,
    );
    expect(factory.forModelListing).not.toHaveBeenCalled();
  });
});
