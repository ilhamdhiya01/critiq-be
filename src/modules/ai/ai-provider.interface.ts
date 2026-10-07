// The one seam between Critiq and any LLM vendor (PRD v1.5.1 D8). Pipeline
// code — the test connection now, the scan prompt builder in step 2 — only
// ever talks to this interface; which SDK sits behind it is the adapter's
// business, chosen per organization by AiProviderFactory.

export type AiProviderName = 'anthropic' | 'openai' | 'openai_compatible';

// JSON Schema for the one tool the model must call. Plain object on purpose:
// every adapter translates it into its own vendor's tool format.
export type JsonSchema = Record<string, unknown>;

export interface AiRequest {
  system: string;
  user: string;
  tool: { name: string; description: string; schema: JsonSchema };
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

export interface AiResult {
  // The tool call's arguments (or the JSON-mode object). Not yet validated —
  // the caller checks it against the schema it asked for.
  toolInput: unknown;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  // 'native' = the vendor's tool/function calling; 'json_mode' = an
  // OpenAI-compatible server that rejected tools and answered in JSON mode.
  structuredOutput: 'native' | 'json_mode';
  // The provider's whole message (every tool call, any text beside it) —
  // only for the encrypted raw response kept when the answer is invalid.
  // Never logged.
  raw?: unknown;
}

// One model a provider offers to this key — for the Settings model picker.
export interface AiModelInfo {
  id: string;
  label: string;
  // Input context window, when the provider says (Anthropic does; OpenAI
  // and gateways do not).
  contextWindow: number | null;
  createdAt: Date | null;
}

export interface AiProvider {
  readonly id: AiProviderName;
  complete(req: AiRequest): Promise<AiResult>;
  // Cheapest call that proves the credentials and model work.
  healthcheck(): Promise<{ model: string }>;
  // The chat models this key can use. Capped; order is the provider's.
  listModels(): Promise<AiModelInfo[]>;
}

// What an adapter needs to be built. `apiKey` is plaintext and lives only as
// long as the adapter — AiProviderFactory decrypts it per call.
export interface AiProviderConfig {
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
}
