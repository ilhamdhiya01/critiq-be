import { Rule, RuleFinding } from '../rule.interface';

// Catches credentials whose variable name gives nothing away — `const k =
// "…"`, `headers: { Authorization: "…" }` — by looking at the value itself.
//
// This is the noisiest rule in the set by construction, so it is layered:
// structural pre-filters here (lockfiles, integrity hashes, imports) reject
// whole categories cheaply, and ValueFilter then rejects by value shape.
// Both matter — the pre-filters catch things that are high-entropy *and*
// legitimate, which no value-shape check could distinguish.
const QUOTED_LITERAL_PATTERN = /["'`]([^"'`\s]{20,256})["'`]/g;

const MIN_ENTROPY_WITH_CLASSES = 3.5;
const MIN_CLASSES = 3;
// A long base64/hex blob is near-uniform and clears this on its own,
// without needing three character classes.
const MIN_ENTROPY_ALONE = 4.2;

// Skipped outright: file types where a long random-looking string is the
// normal content, not an anomaly.
const SKIP_EXTENSIONS = ['.svg', '.css', '.html', '.htm'];

// Lockfile-ish JSON — integrity hashes and resolved URLs are exactly the
// shape this rule looks for, in a file where they are all there is.
const LOCKFILE_MARKERS = ['"integrity"', '"resolved"', 'sha512-', 'sha1-'];

// Line-level markers: the value is a module path, a URL, an inline asset or
// a subresource-integrity hash, none of which are credentials.
const SKIP_LINE_MARKERS = [
  'import ',
  'require(',
  'from "',
  "from '",
  'url(',
  'data:',
  'sha256-',
  'sha384-',
  'sha512-',
  'integrity',
];

// Above this the file is generated or vendored in practice, and scanning
// every literal in it is a waste of the scan budget.
const MAX_FILE_BYTES = 512 * 1024;
// One pathological minified line can hold thousands of literals; past this
// point the marginal chance of a real finding does not pay for the time.
const MAX_LITERALS_PER_FILE = 2000;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function characterClasses(value: string): number {
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  if (/[^A-Za-z0-9]/.test(value)) classes += 1;
  return classes;
}

function looksRandom(value: string): boolean {
  const entropy = shannonEntropy(value);
  if (entropy >= MIN_ENTROPY_ALONE) {
    return true;
  }
  return (
    entropy >= MIN_ENTROPY_WITH_CLASSES &&
    characterClasses(value) >= MIN_CLASSES
  );
}

export const secretHighEntropyStringRule: Rule = {
  id: 'secret.high_entropy_string',
  severity: 'critical',
  title: 'High-entropy string committed',
  message:
    'This is a long, random-looking literal, which is what an API key or token looks like. If it is a credential, move it to an environment variable or secrets manager and rotate it; if it is not, the surrounding code is clearer with a named constant.',
  languages: '*',
  patterns: [QUOTED_LITERAL_PATTERN],
  test(ctx) {
    const lowerPath = ctx.filePath.toLowerCase();
    if (SKIP_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) {
      return [];
    }
    if (ctx.sizeBytes !== undefined && ctx.sizeBytes > MAX_FILE_BYTES) {
      return [];
    }

    const findings: RuleFinding[] = [];
    let literalsSeen = 0;

    for (const line of ctx.addedLines) {
      const lower = line.text.toLowerCase();
      if (LOCKFILE_MARKERS.some((marker) => lower.includes(marker))) {
        continue;
      }
      if (SKIP_LINE_MARKERS.some((marker) => lower.includes(marker))) {
        continue;
      }

      QUOTED_LITERAL_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = QUOTED_LITERAL_PATTERN.exec(line.text)) !== null) {
        literalsSeen += 1;
        if (literalsSeen > MAX_LITERALS_PER_FILE) {
          return findings;
        }

        const value = match[1];
        if (!looksRandom(value)) {
          continue;
        }

        findings.push({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          snippet: value.slice(0, 4) + '****',
          candidate: {
            ruleId: 'secret.high_entropy_string',
            line: line.newLine,
            value,
            raw: line.text,
          },
        });
        // One finding per line is enough — a second literal on the same
        // line would produce a near-duplicate pointing at the same place.
        break;
      }
    }
    return findings;
  },
};
