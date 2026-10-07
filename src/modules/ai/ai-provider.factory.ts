import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AnthropicProvider } from './adapters/anthropic.provider';
import { OpenAiCompatibleProvider } from './adapters/openai-compatible.provider';
import { OpenAiProvider } from './adapters/openai.provider';
import { AiError } from './ai-error';
import {
  defaultModelFor,
  toProviderEnum,
  toProviderName,
} from './ai-models.constants';
import {
  AiProvider,
  AiProviderConfig,
  AiProviderName,
} from './ai-provider.interface';
import { assertSafeBaseUrl } from './base-url-guard';

// Settings → Test connection can try a configuration before it is saved.
// Anything given here wins over what is stored; the key is used for this
// one adapter and never persisted.
const MODEL_LISTING_PLACEHOLDER = 'model-listing';

export interface AiProviderOverride {
  provider?: AiProviderName;
  model?: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export function createAiProvider(
  name: AiProviderName,
  config: AiProviderConfig,
): AiProvider {
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAiProvider(config);
    case 'openai_compatible':
      return new OpenAiCompatibleProvider(config);
  }
}

@Injectable()
export class AiProviderFactory {
  private readonly allowlist: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    configService: ConfigService,
  ) {
    this.allowlist =
      configService.get<string[]>('ai.compatHttpAllowlist') ?? [];
  }

  // Builds the organization's adapter. The key is decrypted here and lives
  // only inside the returned adapter; callers must not keep it around.
  // `organizationId` must already be tenant-checked by the caller (the
  // route's OrgRolesGuard, or the scan job's own org id).
  async for(
    organizationId: string,
    override: AiProviderOverride = {},
  ): Promise<AiProvider> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { aiProvider: true, aiModel: true },
    });
    const stored = organization?.aiProvider
      ? toProviderName(organization.aiProvider)
      : null;
    const name = override.provider ?? stored;
    if (!name) {
      throw new AiError('not_configured', {
        providerMessage: 'No AI provider is selected.',
      });
    }

    const credential = await this.prisma.aiCredential.findUnique({
      where: {
        organizationId_provider: {
          organizationId,
          provider: toProviderEnum(name),
        },
      },
    });

    const model =
      override.model ??
      (name === stored ? organization?.aiModel : null) ??
      defaultModelFor(name);
    if (!model) {
      throw new AiError('not_configured', {
        providerMessage: 'No model is selected.',
      });
    }

    const apiKey = override.apiKey
      ? override.apiKey
      : credential?.encryptedKey
        ? this.encryptionService.decrypt(credential.encryptedKey)
        : null;
    if (name !== 'openai_compatible' && !apiKey) {
      throw new AiError('api_key_required');
    }

    let baseUrl: string | null = null;
    if (name === 'openai_compatible') {
      baseUrl = override.baseUrl ?? credential?.baseUrl ?? null;
      if (!baseUrl) {
        throw new AiError('base_url_required');
      }
      // Re-checked on every use, not just on save: the host's DNS may have
      // changed since, or the allowlist may have.
      await assertSafeBaseUrl(baseUrl, this.allowlist);
    }

    return createAiProvider(name, { model, apiKey, baseUrl });
  }

  // For listing the models a key can use: the same key, base URL and SSRF
  // checks as `for`, without a model having to be chosen yet (an
  // openai_compatible org has no default model). The adapter is only asked
  // for listModels(), so the model name is never sent anywhere.
  forModelListing(
    organizationId: string,
    override: AiProviderOverride = {},
  ): Promise<AiProvider> {
    return this.for(organizationId, {
      ...override,
      model: override.model ?? MODEL_LISTING_PLACEHOLDER,
    });
  }

  compatAllowlist(): readonly string[] {
    return this.allowlist;
  }
}
