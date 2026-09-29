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
}

export interface AiProvider {
  readonly id: AiProviderName;
  complete(req: AiRequest): Promise<AiResult>;
  // Cheapest call that proves the credentials and model work.
  healthcheck(): Promise<{ model: string }>;
}

// What an adapter needs to be built. `apiKey` is plaintext and lives only as
// long as the adapter — AiProviderFactory decrypts it per call.
export interface AiProviderConfig {
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
}
