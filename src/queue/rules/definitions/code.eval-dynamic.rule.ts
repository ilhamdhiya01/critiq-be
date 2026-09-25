import { Rule, RuleFinding } from '../rule.interface';

// Finds the argument text between a call's opening "(" and its matching
// closing ")", respecting nested parens — a plain regex stopping at the
// first ")" breaks on calls like eval('foo(1)'). Returns null if the
// parens are unbalanced (shouldn't happen on a real line, but a diff line
// can legitimately be a fragment of a multi-line call).
function extractBalancedArgs(
  text: string,
  openParenIndex: number,
): string | null {
  let depth = 0;
  for (let i = openParenIndex; i < text.length; i++) {
    if (text[i] === '(') {
      depth++;
    } else if (text[i] === ')') {
      depth--;
      if (depth === 0) {
        return text.slice(openParenIndex + 1, i);
      }
    }
  }
  return null;
}

// A single string literal argument is "safe" only if it has no
// interpolation — a template literal containing ${...} still executes
// attacker-controlled content if that expression is attacker-influenced.
const SINGLE_OR_DOUBLE_QUOTED_LITERAL =
  /^'(?:[^'\\]|\\.)*'$|^"(?:[^"\\]|\\.)*"$/;
const TEMPLATE_LITERAL_NO_INTERPOLATION = /^`(?:[^`\\$]|\\.|\$(?!\{))*`$/;

function hasNonLiteralArgument(rawArgs: string): boolean {
  const trimmed = rawArgs.trim();
  if (trimmed === '') {
    // No argument at all (e.g. `eval()`) — not exploitable, not flagged.
    return false;
  }
  return (
    !SINGLE_OR_DOUBLE_QUOTED_LITERAL.test(trimmed) &&
    !TEMPLATE_LITERAL_NO_INTERPOLATION.test(trimmed)
  );
}

function findCallArgs(text: string, calleePattern: RegExp): string | null {
  const match = calleePattern.exec(text);
  if (!match) {
    return null;
  }
  const openParenIndex = match.index + match[0].length - 1;
  return extractBalancedArgs(text, openParenIndex);
}

const JS_EVAL_CALLEE = /\beval\s*\(/;
const JS_NEW_FUNCTION_CALLEE = /\bnew\s+Function\s*\(/;
const PY_EVAL_EXEC_CALLEE = /\b(?:eval|exec)\s*\(/;

export const codeEvalDynamicRule: Rule = {
  id: 'code.eval_dynamic',
  severity: 'critical',
  title: 'Dynamic code execution with non-literal input',
  message:
    'eval()/new Function() (or Python eval()/exec()) with a non-literal argument can execute attacker-controlled code if that input is ever influenced by user data. Avoid dynamic evaluation entirely, or strictly validate/allowlist the input if it is unavoidable.',
  languages: ['js', 'py'],
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const callees =
        ctx.language === 'py'
          ? [PY_EVAL_EXEC_CALLEE]
          : [JS_EVAL_CALLEE, JS_NEW_FUNCTION_CALLEE];

      for (const callee of callees) {
        const args = findCallArgs(line.text, callee);
        if (args !== null && hasNonLiteralArgument(args)) {
          findings.push({
            lineStart: line.newLine,
            lineEnd: line.newLine,
            snippet: line.text.trim().slice(0, 200),
          });
          break;
        }
      }
    }
    return findings;
  },
};
