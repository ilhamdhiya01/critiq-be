import { AiRequest } from './ai-provider.interface';

// The fixed request behind Settings → Test connection: small, cheap, and
// shaped like the real review call (system prompt, a diff, one forced tool),
// so passing it means step 2's structured output will work with this
// provider/model — not merely that the key authenticates.
const TEST_DIFF = [
  'diff --git a/src/http/client.ts b/src/http/client.ts',
  '--- a/src/http/client.ts',
  '+++ b/src/http/client.ts',
  '@@ -1,14 +1,17 @@',
  " import https from 'https';",
  " import axios from 'axios';",
  ' ',
  ' export function createClient(baseURL: string) {',
  '+  const agent = new https.Agent({',
  '+    rejectUnauthorized: false,',
  '+  });',
  '   return axios.create({',
  '     baseURL,',
  '     timeout: 10_000,',
  '+    httpsAgent: agent,',
  '   });',
  ' }',
  ' ',
  ' export const api = createClient(process.env.API_URL!);',
  '',
].join('\n');

export const TEST_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
        },
        required: ['file', 'line', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
};

export const TEST_REQUEST: AiRequest = {
  system: 'You are a code reviewer. Reply only via the tool.',
  user: `Review this diff and report issues.\n\n${TEST_DIFF}`,
  tool: {
    name: 'report_review_test',
    description: 'Report a short summary and the issues found in the diff.',
    schema: TEST_TOOL_SCHEMA,
  },
  maxTokens: 300,
  temperature: 0,
  timeoutMs: 30_000,
};
