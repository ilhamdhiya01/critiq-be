import { Rule, RuleFinding } from '../rule.interface';
import { CRITICAL_PATH_PATTERN } from '../rules.constants';

// An error swallowed where it matters most: auth, sessions and tokens,
// payments, webhooks. A failure there that is caught and ignored lets the
// request carry on as if it succeeded — a login that never checked, a
// charge that never happened. Elsewhere the same pattern is left to the AI
// review, which can rate it below Critical.
//
// Only an empty handler counts. A handler with a comment in it is a
// decision someone wrote down, not an accident.
// With and without a binding, as two patterns: an optional group around a
// repeated class is the nested quantifier safe-regex2 rejects.
const JS_INLINE_EMPTY = /\bcatch *\{ *\}/;
const JS_INLINE_EMPTY_BOUND = /\bcatch *\([\w$ ]*\) *\{ *\}/;
const JS_CATCH_OPEN = /\bcatch *\{ *$/;
const JS_CATCH_OPEN_BOUND = /\bcatch *\([\w$ ]*\) *\{ *$/;
const JS_BLOCK_CLOSE = /^\s*\}/;
const JS_PROMISE_SWALLOW =
  /\.catch\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|null|undefined|void 0)\s*\)/;
// A swallowed promise only counts when its value is used — returned or
// assigned, so the caller gets null instead of an error. A bare
// `await cleanup().catch(() => undefined);` is best-effort cleanup.
const VALUE_USED = /(?:\breturn\b|[^=!<>]=[^=>]|=>)/;
const PY_INLINE_PASS = /^\s*except\b[^:#]*:\s*pass\s*$/;
const PY_EXCEPT_OPEN = /^\s*except\b[^:#]*:\s*$/;
const PY_PASS = /^\s*pass\s*$/;

export const codeEmptyCatchRule: Rule = {
  id: 'code.empty_catch',
  severity: 'critical',
  title: 'Error swallowed on a critical path',
  message:
    'This catches an error and does nothing with it, on an auth, token, payment or webhook path. The request carries on as if the operation succeeded. Handle the error, or let it propagate so the caller can fail safely.',
  languages: ['js', 'py'],
  patterns: [
    JS_INLINE_EMPTY,
    JS_INLINE_EMPTY_BOUND,
    JS_CATCH_OPEN,
    JS_CATCH_OPEN_BOUND,
    VALUE_USED,
    JS_BLOCK_CLOSE,
    JS_PROMISE_SWALLOW,
    PY_INLINE_PASS,
    PY_EXCEPT_OPEN,
    PY_PASS,
  ],
  test(ctx) {
    if (!CRITICAL_PATH_PATTERN.test(ctx.filePath)) {
      return [];
    }
    const py = ctx.language === 'py';
    const byLine = new Map(
      ctx.addedLines.map((line) => [line.newLine, line.text]),
    );
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const next = byLine.get(line.newLine + 1);
      const text = line.text;
      const promise = JS_PROMISE_SWALLOW.exec(text);
      const inline = py
        ? PY_INLINE_PASS.test(text)
        : JS_INLINE_EMPTY.test(text) ||
          JS_INLINE_EMPTY_BOUND.test(text) ||
          (promise !== null && VALUE_USED.test(text.slice(0, promise.index)));
      const opensEmpty =
        next !== undefined &&
        (py
          ? PY_EXCEPT_OPEN.test(text) && PY_PASS.test(next)
          : (JS_CATCH_OPEN.test(text) || JS_CATCH_OPEN_BOUND.test(text)) &&
            JS_BLOCK_CLOSE.test(next));
      if (!inline && !opensEmpty) {
        continue;
      }
      findings.push({
        lineStart: line.newLine,
        lineEnd: opensEmpty && !inline ? line.newLine + 1 : line.newLine,
        snippet: text.trim(),
      });
    }
    return findings;
  },
};
