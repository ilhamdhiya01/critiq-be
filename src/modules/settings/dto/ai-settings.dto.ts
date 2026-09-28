import type { ProviderCatalogEntry } from '../../ai/ai-models.constants';
import type { AiProviderName } from '../../ai/ai-provider.interface';

export interface AiCredentialSummary {
  hasKey: boolean;
  last4?: string;
  baseUrl?: string | null;
}

export interface AiTestSnapshot {
  at: string;
  ok: boolean;
  latencyMs: number;
  structuredOutput: 'native' | 'json_mode' | 'failed';
  model: string | null;
}

// GET/PUT …/settings/ai. The key itself never appears here — only whether
// one is stored and its last four characters.
export class AiSettingsDto {
  provider!: AiProviderName | null;
  model!: string | null;
  baseUrl!: string | null;
  credentials!: Record<AiProviderName, AiCredentialSummary>;
  consent!:
    | {
        granted: true;
        at: Date;
        by: { id: string; name: string | null } | null;
      }
    | { granted: false };
  locale!: string;
  dailyTokenBudget!: number;
  providers!: ProviderCatalogEntry[];
  lastTest!: AiTestSnapshot | null;

  constructor(partial: AiSettingsDto) {
    Object.assign(this, partial);
  }
}

// POST …/settings/ai/test.
export class AiTestResultDto {
  ok!: boolean;
  latencyMs!: number;
  model!: string | null;
  structuredOutput!: 'native' | 'json_mode' | 'failed';
  usage!: { inputTokens: number; outputTokens: number } | null;
  error!: { code: string; message: string } | null;

  constructor(partial: AiTestResultDto) {
    Object.assign(this, partial);
  }
}
