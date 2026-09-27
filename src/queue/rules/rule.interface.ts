// What a secret rule actually matched, handed to ValueFilter (which decides
// whether it is a real credential or noise) and to the processor's
// fingerprint. Never persisted and never logged: `raw` is the whole source
// line and `value` the credential itself, so both exist only in memory
// between a rule returning and the runner filtering. The runner strips this
// off before a finding leaves it — see rule-runner.ts.
export interface SecretCandidate {
  ruleId: string;
  line: number;
  // Absent for rules that match a bare credential with no assignment around
  // it (an AWS key id, a PEM block) — fingerprinting treats that as ''.
  key?: string;
  value: string;
  raw: string;
}

export interface RuleFinding {
  lineStart: number;
  lineEnd: number;
  // null when redacted — secret.* rules must never persist the raw matched
  // credential, even to a security-review UI.
  snippet: string | null;
  candidate?: SecretCandidate;
}

export interface RuleFileContext {
  filePath: string;
  language: string; // 'js' | 'py' | 'go' | 'php' | 'rb' | 'java' | 'dockerfile' | '*'
  addedLines: { newLine: number; text: string }[];
  // Diff metadata, optional so every existing line rule and fixture-based
  // spec keeps working untouched. File rules (kind: 'file') require `status`
  // — they exist to flag a credential file being *added*, which is not
  // something the file's contents can tell you.
  status?: 'added' | 'removed' | 'modified' | 'renamed';
  previousPath?: string | null;
  // Patch size in bytes, used to skip the entropy rule on very large files.
  sizeBytes?: number;
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
  // 'file' rules look only at path + status and ignore addedLines entirely,
  // so they also run on files with no parseable patch (binary or oversized
  // blobs arrive with patch: null — exactly how a real private key shows up).
  // Absent means 'line'.
  kind?: 'file' | 'line';
  // Opt out of ValueFilter. Only for provider rules whose prefix already
  // proves provenance (AKIA, ghp_, sk_live_): AWS publishes
  // AKIAIOSFODNN7EXAMPLE as its documented example key, so the filter's
  // placeholder check would throw away a genuine positive.
  skipValueFilter?: boolean;
  // Every regex the rule uses, so rules.spec.ts can assert all of them pass
  // safe-regex2 without each rule needing its own test for that. A rule
  // added later is covered automatically.
  patterns?: RegExp[];
  test(ctx: RuleFileContext): RuleFinding[];
}
