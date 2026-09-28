import { findCodeMatch } from '../line-context';
import { Rule, RuleFinding } from '../rule.interface';

// origin: '*' and credentials: true are each individually fine, but
// together they're a real vulnerability: a wildcard origin combined with
// credentials allowed lets any website read authenticated responses
// (browsers are supposed to reject this combination, but plenty of CORS
// middlewares/configs still let you misconfigure it server-side). Scanned
// within a 5-line window on ADDED lines only, since the two options
// commonly appear a line or two apart in a config object.
const ORIGIN_WILDCARD_PATTERN = /origin\s*:\s*['"]\*['"]/;
const CREDENTIALS_TRUE_PATTERN = /credentials\s*:\s*true/;
const WINDOW_SIZE = 5;

export const configCorsWildcardCredentialsRule: Rule = {
  id: 'config.cors_wildcard_credentials',
  severity: 'critical',
  title: 'CORS wildcard origin combined with credentials: true',
  message:
    "origin: '*' with credentials: true lets any website read authenticated cross-origin responses. Set an explicit allowlist of origins when credentials are enabled — never a wildcard.",
  languages: ['js'],
  test(ctx) {
    const findings: RuleFinding[] = [];
    const { addedLines } = ctx;
    for (let i = 0; i < addedLines.length; i++) {
      // Both halves must be actual config, not a comment or a string that
      // merely describes the combination (e.g. this rule's own `message`).
      const origin = findCodeMatch(
        ORIGIN_WILDCARD_PATTERN,
        addedLines[i].text,
        ctx.language,
      );
      if (!origin) {
        continue;
      }
      const windowEnd = Math.min(addedLines.length, i + WINDOW_SIZE);
      for (let j = i; j < windowEnd; j++) {
        if (
          findCodeMatch(
            CREDENTIALS_TRUE_PATTERN,
            addedLines[j].text,
            ctx.language,
          )
        ) {
          // Position of the origin half, on lineStart — that is the line the
          // processor checks for a regex literal.
          findings.push({
            lineStart: addedLines[i].newLine,
            lineEnd: addedLines[j].newLine,
            snippet: null,
            matchStart: origin.start,
            matchLength: origin.length,
          });
          break;
        }
      }
    }
    return findings;
  },
};
