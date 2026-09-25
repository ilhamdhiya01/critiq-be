export interface RuleFinding {
  lineStart: number;
  lineEnd: number;
  // null when redacted — secret.* rules must never persist the raw matched
  // credential, even to a security-review UI.
  snippet: string | null;
}

export interface RuleFileContext {
  filePath: string;
  language: string; // 'js' | 'py' | 'go' | 'php' | 'rb' | 'java' | 'dockerfile' | '*'
  addedLines: { newLine: number; text: string }[];
}

export interface Rule {
  id: string;
  // Modeled as a literal union of one value on purpose — the Finding/DB
  // layer models the full critical|major|minor|info range for future use,
  // but no rule in this MVP is allowed to emit anything but critical.
  severity: 'critical';
  title: string;
  message: string; // why this is Critical + a one-sentence fix suggestion
  languages: string[] | '*';
  test(ctx: RuleFileContext): RuleFinding[];
}
