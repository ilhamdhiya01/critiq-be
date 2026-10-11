import { Rule, RuleFinding } from '../rule.interface';

// A secret read from the environment with a literal fallback: when the
// variable is missing in production the app runs on the fallback, which is
// in git for anyone to read — `process.env.JWT_SECRET ?? 'dev-secret'`.
// Unlike secret.assignment_literal, a placeholder-looking fallback is not
// excused: 'changeme' signing production tokens is exactly the problem.
const JS_FALLBACK_PATTERN =
  /process\.env(?:\.([A-Za-z0-9_]+)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])\s*(?:\?\?|\|\|)\s*['"`]([^'"`]{4,})['"`]/;
const PY_FALLBACK_PATTERN =
  /os\.(?:getenv|environ\.get)\(\s*['"]([A-Za-z0-9_]+)['"]\s*,\s*['"]([^'"]{4,})['"]/;
const SECRET_NAME_PATTERN =
  /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY)/i;

export const secretEnvFallbackRule: Rule = {
  id: 'secret.env_fallback',
  severity: 'critical',
  title: 'Secret with a hard-coded fallback',
  message:
    'This reads a secret from the environment but falls back to a literal value, so a missing variable in production silently runs on a secret that is in git. Fail at startup when the variable is missing instead of falling back.',
  languages: ['js', 'py'],
  patterns: [JS_FALLBACK_PATTERN, PY_FALLBACK_PATTERN, SECRET_NAME_PATTERN],
  test(ctx) {
    const findings: RuleFinding[] = [];
    const pattern =
      ctx.language === 'py' ? PY_FALLBACK_PATTERN : JS_FALLBACK_PATTERN;
    for (const line of ctx.addedLines) {
      const match = pattern.exec(line.text);
      if (!match) {
        continue;
      }
      const name = match[1] ?? match[2];
      if (!name || !SECRET_NAME_PATTERN.test(name)) {
        continue;
      }
      findings.push({
        lineStart: line.newLine,
        lineEnd: line.newLine,
        matchStart: match.index,
        matchLength: match[0].length,
        snippet: null,
      });
    }
    return findings;
  },
};
