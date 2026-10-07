import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderId } from '../../generated/prisma/enums';
import { AiProviderFactory } from './ai-provider.factory';
import { assertSafeBaseUrl } from './base-url-guard';

jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('../../common/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('./base-url-guard', () => ({
  assertSafeBaseUrl: jest.fn().mockResolvedValue(undefined),
}));

// A gateway org that has not picked a model yet — the state the Settings
// model picker is used in.
function setup() {
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        aiProvider: AiProviderId.OPENAI_COMPATIBLE,
        aiModel: null,
      }),
    },
    aiCredential: {
      findUnique: jest.fn().mockResolvedValue({
        encryptedKey: 'enc',
        baseUrl: 'https://ai.example.com/v1',
      }),
    },
  };
  const factory = new AiProviderFactory(
    prisma as unknown as PrismaService,
    { decrypt: () => 'key' } as unknown as EncryptionService,
    { get: () => [] } as unknown as ConfigService,
  );
  return { factory };
}

describe('AiProviderFactory.forModelListing', () => {
  it('builds the adapter before a model is chosen', async () => {
    const { factory } = setup();

    await expect(factory.for('org_1')).rejects.toMatchObject({
      code: 'not_configured',
    });
    const adapter = await factory.forModelListing('org_1');

    expect(adapter.id).toBe('openai_compatible');
  });

  it('keeps the base URL check of a normal call', async () => {
    const { factory } = setup();
    await factory.forModelListing('org_1', {
      provider: 'openai_compatible',
      baseUrl: 'https://other.example.com/v1',
    });
    expect(assertSafeBaseUrl).toHaveBeenLastCalledWith(
      'https://other.example.com/v1',
      [],
    );
  });
});
