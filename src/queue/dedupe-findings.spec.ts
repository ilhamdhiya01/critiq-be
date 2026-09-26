import { dedupeFindings, LocatedHit } from './dedupe-findings';

function hit(overrides: Partial<LocatedHit> = {}): LocatedHit {
  return {
    ruleId: 'secret.assignment_literal',
    severity: 'critical',
    title: 'Hardcoded credential',
    message: 'Move it to an environment variable.',
    filePath: '.env',
    lineStart: 10,
    lineEnd: 10,
    snippet: 'API_SECRET=abcd****',
    identity: { key: 'API_SECRET', valuePrefix: 'abcd', valueLength: 24 },
    ...overrides,
  };
}

describe('dedupeFindings', () => {
  // Acceptance 23.
  it('merges the same credential across lines and records the count', () => {
    const findings = dedupeFindings([
      hit({ lineStart: 10, lineEnd: 10 }),
      hit({ lineStart: 42, lineEnd: 42 }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0].lineStart).toBe(10);
    expect(findings[0].lineEnd).toBe(42);
    expect(findings[0].message).toMatch(/\(muncul di 2 baris\)$/);
  });

  it('leaves a single occurrence unannotated', () => {
    const findings = dedupeFindings([hit()]);
    expect(findings[0].message).not.toMatch(/muncul di/);
  });

  // The identity is what makes merging safe. Any one of key, prefix or
  // length differing means these are different credentials.
  it.each([
    [
      'a different key',
      { key: 'OTHER_SECRET', valuePrefix: 'abcd', valueLength: 24 },
    ],
    [
      'a different prefix',
      { key: 'API_SECRET', valuePrefix: 'wxyz', valueLength: 24 },
    ],
    [
      'a different length',
      { key: 'API_SECRET', valuePrefix: 'abcd', valueLength: 31 },
    ],
  ])('keeps two findings apart when they have %s', (_label, identity) => {
    const findings = dedupeFindings([
      hit({ lineStart: 10, lineEnd: 10 }),
      hit({ lineStart: 42, lineEnd: 42, identity }),
    ]);
    expect(findings).toHaveLength(2);
  });

  it('does not merge across files', () => {
    const findings = dedupeFindings([
      hit({ filePath: '.env' }),
      hit({ filePath: 'config/.env.staging' }),
    ]);
    expect(findings).toHaveLength(2);
  });

  // Without an identity there is nothing to tell two values apart: secret
  // snippets are masked, so every AWS key reads "AKIA****". Merging on that
  // would turn two separate leaks into one misleading line range, so these
  // fall back to per-line fingerprints and never merge.
  it('never merges secret findings that carry no identity', () => {
    const noIdentity = {
      ruleId: 'secret.aws_access_key',
      snippet: 'AKIA****',
      identity: undefined,
    };
    const findings = dedupeFindings([
      hit({ ...noIdentity, lineStart: 3, lineEnd: 3 }),
      hit({ ...noIdentity, lineStart: 40, lineEnd: 40 }),
    ]);

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.lineStart).sort((a, b) => a - b)).toEqual([
      3, 40,
    ]);
  });

  // Non-secret rules keep the original snippet-based behaviour: their
  // snippets are the actual source line, which does discriminate.
  it('merges code findings with identical snippets', () => {
    const codeHit = {
      ruleId: 'code.debugger_left',
      filePath: 'src/app.ts',
      snippet: 'debugger;',
      identity: undefined,
    };
    const findings = dedupeFindings([
      hit({ ...codeHit, lineStart: 5, lineEnd: 5 }),
      hit({ ...codeHit, lineStart: 9, lineEnd: 9 }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0].lineStart).toBe(5);
    expect(findings[0].lineEnd).toBe(9);
  });

  it('produces a stable fingerprint for the same input', () => {
    const [first] = dedupeFindings([hit()]);
    const [second] = dedupeFindings([hit()]);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  // The fingerprint must not be a handle on the credential itself.
  it('hashes no more of the value than the snippet already shows', () => {
    const [finding] = dedupeFindings([
      hit({
        identity: {
          key: 'API_SECRET',
          valuePrefix: 'abcd',
          valueLength: 24,
        },
      }),
    ]);
    expect(finding.fingerprint).not.toContain('abcd');
  });
});
