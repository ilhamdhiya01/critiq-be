import { HttpStatus } from '@nestjs/common';
import { Logger } from 'winston';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimiterService } from '../../common/redis/rate-limiter.service';
import { AiProviderId, AiUsageKind } from '../../generated/prisma/enums';
import { AiError } from '../ai/ai-error';
import { AiProviderFactory } from '../ai/ai-provider.factory';
import { AiProvider } from '../ai/ai-provider.interface';
import { SettingsService } from './settings.service';

// ESM-only / heavy modules this CommonJS Jest setup cannot load; every
// collaborator is a stub below (same pattern as webhooks.service.spec.ts).
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('../../common/redis/rate-limiter.service', () => ({
  RateLimiterService: class {},
}));
jest.mock('../ai/ai-provider.factory', () => ({ AiProviderFactory: class {} }));

const ORG = 'org_1';
const ADMIN = 'u_admin';
const ANTHROPIC_KEY = 'sk-ant-test-0000000000004Kd2';
const OPENAI_KEY = 'sk-openai-test-00000000009zX1';

interface CredentialRow {
  organizationId: string;
  provider: AiProviderId;
  encryptedKey: string | null;
  keyLast4: string | null;
  baseUrl: string | null;
  updatedBy: string | null;
}

// Just enough of Prisma, in memory, for SettingsService's queries.
function fakePrisma() {
  const org: Record<string, unknown> = {
    aiProvider: null,
    aiModel: null,
    aiConsentAt: null,
    aiConsentBy: null,
    aiLocale: 'en',
    aiDailyTokenBudget: 2_000_000,
    aiLastTest: null,
  };
  const users: Record<string, { id: string; name: string }> = {
    [ADMIN]: { id: ADMIN, name: 'Ilham' },
  };
  const credentials: CredentialRow[] = [];
  const readOrg = () =>
    Promise.resolve({
      ...org,
      aiConsentUser: org.aiConsentBy ? users[org.aiConsentBy as string] : null,
    });

  const prisma = {
    organization: {
      findUniqueOrThrow: jest.fn(readOrg),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(data)) {
          if (key === 'aiConsentUser') {
            const relation = value as { connect?: { id: string } };
            org.aiConsentBy = relation.connect?.id ?? null;
          } else {
            org[key] = value;
          }
        }
        return readOrg();
      }),
      count: jest.fn(),
    },
    aiCredential: {
      findMany: jest.fn(() =>
        Promise.resolve(credentials.map((row) => ({ ...row }))),
      ),
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: { organizationId_provider: { provider: AiProviderId } };
        }) =>
          Promise.resolve(
            credentials.find(
              (row) => row.provider === where.organizationId_provider.provider,
            ) ?? null,
          ),
      ),
      upsert: jest.fn(
        ({
          create,
          update,
        }: {
          create: CredentialRow;
          update: Partial<CredentialRow>;
        }) => {
          const existing = credentials.find(
            (row) => row.provider === create.provider,
          );
          if (existing) {
            Object.assign(existing, update);
          } else {
            credentials.push({ ...create });
          }
          return Promise.resolve();
        },
      ),
    },
    aiUsageDaily: { upsert: jest.fn().mockResolvedValue(undefined) },
    membership: {
      findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN' }),
    },
  };
  // Added after the object exists: the transaction client is the fake itself.
  const withTransaction = Object.assign(prisma, {
    $transaction: jest.fn((run: (tx: typeof prisma) => Promise<unknown>) =>
      run(prisma),
    ),
  });
  return { prisma: withTransaction, org, credentials };
}

function setup() {
  const { prisma, org, credentials } = fakePrisma();
  const encryption = new EncryptionService({
    getOrThrow: () => 'ab'.repeat(32),
  } as never);
  let testsThisHour = 0;
  const rateLimiter = {
    tryConsume: jest.fn(() => Promise.resolve(++testsThisHour <= 5)),
  };
  const provider: jest.Mocked<AiProvider> = {
    id: 'anthropic',
    complete: jest.fn().mockResolvedValue({
      toolInput: { summary: 'Disables TLS verification.', findings: [] },
      usage: { inputTokens: 410, outputTokens: 62 },
      model: 'claude-sonnet-5',
      structuredOutput: 'native',
    }),
    healthcheck: jest.fn().mockResolvedValue({ model: 'claude-sonnet-5' }),
  };
  const factory = {
    for: jest.fn().mockResolvedValue(provider),
    compatAllowlist: () => ['vllm.internal', '10.0.0.5'],
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new SettingsService(
    prisma as unknown as PrismaService,
    encryption,
    factory as unknown as AiProviderFactory,
    rateLimiter as unknown as RateLimiterService,
    logger as unknown as Logger,
  );
  return {
    service,
    prisma,
    org,
    credentials,
    encryption,
    provider,
    factory,
    logger,
  };
}

function unprocessable(message: string) {
  return {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    response: expect.objectContaining({ message }) as unknown,
  };
}

describe('SettingsService — AI settings', () => {
  // Acceptance 1.
  it('stores the key encrypted and never returns it', async () => {
    const { service, credentials, encryption, logger } = setup();

    const settings = await service.updateAi(ORG, ADMIN, {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: ANTHROPIC_KEY,
    });

    expect(settings.provider).toBe('anthropic');
    expect(settings.credentials.anthropic).toEqual({
      hasKey: true,
      last4: '4Kd2',
    });
    const [row] = credentials;
    expect(row.encryptedKey).not.toContain(ANTHROPIC_KEY);
    expect(encryption.decrypt(row.encryptedKey!)).toBe(ANTHROPIC_KEY);
    expect(JSON.stringify(settings)).not.toContain(ANTHROPIC_KEY);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(ANTHROPIC_KEY);
    expect(logger.info).toHaveBeenCalledWith(
      'audit.ai.settings_changed',
      expect.objectContaining({
        fields: expect.arrayContaining([
          'provider',
          'model',
          'apiKey',
        ]) as unknown,
      }),
    );
  });

  // Acceptance 4 (settings half) and 6.
  it('requires a base URL for openai_compatible but not a key', async () => {
    const { service } = setup();
    await expect(
      service.updateAi(ORG, ADMIN, { provider: 'openai_compatible' }),
    ).rejects.toMatchObject(unprocessable('base_url_required'));

    const settings = await service.updateAi(ORG, ADMIN, {
      provider: 'openai_compatible',
      baseUrl: 'https://vllm.internal/v1',
      model: 'llama-3.1-70b-instruct',
    });
    expect(settings.provider).toBe('openai_compatible');
    expect(settings.baseUrl).toBe('https://vllm.internal/v1');
    expect(settings.credentials.openai_compatible.hasKey).toBe(false);
  });

  it('requires a key when selecting anthropic/openai', async () => {
    const { service } = setup();
    await expect(
      service.updateAi(ORG, ADMIN, { provider: 'openai' }),
    ).rejects.toMatchObject(unprocessable('api_key_required'));
  });

  // Acceptance 5 (settings half).
  it.each([
    'http://10.0.0.99:8000/v1',
    'https://user:pass@vllm.internal/v1',
    'https://127.0.0.1/v1',
  ])('rejects the base URL %s', async (baseUrl) => {
    const { service } = setup();
    await expect(
      service.updateAi(ORG, ADMIN, { provider: 'openai_compatible', baseUrl }),
    ).rejects.toMatchObject(unprocessable('insecure_base_url'));
  });

  it('accepts plain http for an allowlisted host', async () => {
    const { service } = setup();
    const settings = await service.updateAi(ORG, ADMIN, {
      provider: 'openai_compatible',
      baseUrl: 'http://10.0.0.5:8000/v1',
    });
    expect(settings.baseUrl).toBe('http://10.0.0.5:8000/v1');
  });

  // Acceptance 7.
  it('keeps each provider’s key when switching back and forth', async () => {
    const { service } = setup();
    await service.updateAi(ORG, ADMIN, {
      provider: 'anthropic',
      apiKey: ANTHROPIC_KEY,
    });
    await service.updateAi(ORG, ADMIN, {
      provider: 'openai',
      apiKey: OPENAI_KEY,
    });
    const back = await service.updateAi(ORG, ADMIN, { provider: 'anthropic' });

    expect(back.provider).toBe('anthropic');
    expect(back.model).toBe('claude-sonnet-5');
    expect(back.credentials.anthropic).toEqual({ hasKey: true, last4: '4Kd2' });
    expect(back.credentials.openai).toEqual({ hasKey: true, last4: '9zX1' });
  });

  // Acceptance 8.
  it('deletes the key on "" and keeps it when apiKey is absent', async () => {
    const { service } = setup();
    await service.updateAi(ORG, ADMIN, {
      provider: 'anthropic',
      apiKey: ANTHROPIC_KEY,
    });

    const kept = await service.updateAi(ORG, ADMIN, { locale: 'id' });
    expect(kept.credentials.anthropic.hasKey).toBe(true);
    expect(kept.locale).toBe('id');

    const deleted = await service.updateAi(ORG, ADMIN, { apiKey: '' });
    expect(deleted.credentials.anthropic).toEqual({ hasKey: false });
  });

  // Acceptance 9.
  it('records and revokes consent with an audit event', async () => {
    const { service, logger } = setup();

    const granted = await service.updateAi(ORG, ADMIN, { consent: true });
    expect(granted.consent).toMatchObject({
      granted: true,
      by: { id: ADMIN, name: 'Ilham' },
    });
    expect(logger.info).toHaveBeenCalledWith('audit.ai.consent_granted', {
      orgId: ORG,
      by: ADMIN,
    });

    const revoked = await service.updateAi(ORG, ADMIN, { consent: false });
    expect(revoked.consent).toEqual({ granted: false });
    expect(logger.info).toHaveBeenCalledWith('audit.ai.consent_revoked', {
      orgId: ORG,
      by: ADMIN,
    });
  });

  // Acceptance 13.
  it('lists google as unavailable and refuses to select it', async () => {
    const { service } = setup();
    const settings = await service.getAi(ORG);
    expect(settings.providers).toContainEqual(
      expect.objectContaining({ id: 'google', available: false }),
    );
    await expect(
      service.updateAi(ORG, ADMIN, { provider: 'google' }),
    ).rejects.toMatchObject(unprocessable('provider_unavailable'));
  });
});

describe('SettingsService — test connection', () => {
  // Acceptance 2.
  it('reports native structured output and records TEST usage', async () => {
    const { service, prisma, org } = setup();

    const result = await service.testAi(ORG, {});

    expect(result).toMatchObject({
      ok: true,
      model: 'claude-sonnet-5',
      structuredOutput: 'native',
      usage: { inputTokens: 410, outputTokens: 62 },
      error: null,
    });
    expect(prisma.aiUsageDaily.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ kind: AiUsageKind.TEST }) as unknown,
      }),
    );
    expect(org.aiLastTest).toMatchObject({
      ok: true,
      structuredOutput: 'native',
    });
    expect(org.aiDailyTokenBudget).toBe(2_000_000);
  });

  // Acceptance 3.
  it('reports auth_failed without throwing', async () => {
    const { service, provider, org } = setup();
    provider.healthcheck.mockRejectedValue(
      new AiError('auth_failed', { status: 401 }),
    );

    const result = await service.testAi(ORG, {});

    expect(result).toMatchObject({
      ok: false,
      model: null,
      structuredOutput: 'failed',
      usage: null,
      error: {
        code: 'auth_failed',
        message: 'Provider rejected the API key (401).',
      },
    });
    expect(org.aiLastTest).toMatchObject({ ok: false });
  });

  it('reports invalid_response when the model never uses the tool', async () => {
    const { service, provider } = setup();
    provider.complete.mockRejectedValue(new AiError('invalid_response'));

    const result = await service.testAi(ORG, {});

    expect(result.structuredOutput).toBe('failed');
    expect(result.error?.code).toBe('invalid_response');
    expect(provider.complete.mock.calls).toHaveLength(2); // one retry
  });

  // Acceptance 10.
  it('allows five tests per hour', async () => {
    const { service } = setup();
    for (let i = 0; i < 5; i += 1) {
      await service.testAi(ORG, {});
    }
    await expect(service.testAi(ORG, {})).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  // Acceptance 11.
  it('tests a key from the body without storing it', async () => {
    const { service, factory, credentials } = setup();
    await service.updateAi(ORG, ADMIN, {
      provider: 'anthropic',
      apiKey: ANTHROPIC_KEY,
    });
    const storedBefore = credentials[0].encryptedKey;

    await service.testAi(ORG, { apiKey: 'sk-ant-candidate-000000000000' });

    expect(factory.for).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ apiKey: 'sk-ant-candidate-000000000000' }),
    );
    expect(credentials[0].encryptedKey).toBe(storedBefore);
  });

  // Acceptance 14.
  it('logs a sanitized provider message', async () => {
    const { service, provider, logger } = setup();
    provider.healthcheck.mockRejectedValue(
      Object.assign(
        new Error('Incorrect API key provided: sk-live-ABCDEFGH12345678'),
        { status: 401 },
      ),
    );

    await service.testAi(ORG, {});

    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('sk-***');
    expect(logged).not.toContain('ABCDEFGH12345678');
  });
});

describe('SettingsService — read access by role', () => {
  // Acceptance 18: Reviewer/Viewer see why AI is off, never the credentials.
  it('gives a non-admin the minimal view', async () => {
    const { service, prisma } = setup();
    await service.updateAi(ORG, ADMIN, {
      provider: 'anthropic',
      apiKey: ANTHROPIC_KEY,
      consent: true,
    });
    prisma.membership.findUnique.mockResolvedValue({ role: 'VIEWER' });

    const view = await service.getAiForMember(ORG, 'u_viewer');

    expect(view).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      consent: { granted: true },
      locale: 'en',
    });
    expect(JSON.stringify(view)).not.toContain('4Kd2');
  });

  it('gives an admin the full settings', async () => {
    const { service } = setup();
    const view = await service.getAiForMember(ORG, ADMIN);
    expect(view).toHaveProperty('credentials');
  });
});
