import {
  isCommentLine,
  isInsideStringLiteral,
  matchesAsCode,
} from '../line-context';
import { Rule, RuleFinding } from '../rule.interface';

// child_process.exec/execSync with a non-literal first argument — exec()
// (unlike execFile) runs its argument through a shell, so string
// interpolation is a real command-injection risk. A literal-only call is
// not flagged for the same reason as code.eval_dynamic.
const JS_EXEC_CALLEE = /\bchild_process\.(?:exec|execSync)\s*\(/;

// Python subprocess.*(..., shell=True, ...) with a non-literal command —
// os.system(...) always runs through a shell, so any non-literal argument
// is a risk.
const PY_SUBPROCESS_SHELL_TRUE_PATTERN =
  /\bsubprocess\.\w+\s*\([^)]*shell\s*=\s*True/;
const PY_OS_SYSTEM_CALLEE = /\bos\.system\s*\(/;

const SINGLE_OR_DOUBLE_QUOTED_LITERAL =
  /^'(?:[^'\\]|\\.)*'$|^"(?:[^"\\]|\\.)*"$/;
const TEMPLATE_LITERAL_NO_INTERPOLATION = /^`(?:[^`\\$]|\\.|\$(?!\{))*`$/;

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

function hasNonLiteralFirstArg(rawArgs: string): boolean {
  const firstArg = rawArgs.split(',')[0]?.trim() ?? '';
  if (firstArg === '') {
    return false;
  }
  return (
    !SINGLE_OR_DOUBLE_QUOTED_LITERAL.test(firstArg) &&
    !TEMPLATE_LITERAL_NO_INTERPOLATION.test(firstArg)
  );
}

export const codeShellInjectionRule: Rule = {
  id: 'code.shell_injection',
  severity: 'critical',
  title: 'Shell command built from non-literal input',
  message:
    'Running a shell command with a non-literal (or shell=True) argument can allow command injection if that input is ever influenced by user data. Prefer an execFile/spawn-style API with an argument array (no shell interpretation), or strictly validate/allowlist the input.',
  languages: ['js', 'py'],
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      if (isCommentLine(line.text)) {
        continue;
      }
      if (ctx.language === 'js') {
        // First call site that is real code, not a mention inside a string.
        const match = [
          ...line.text.matchAll(new RegExp(JS_EXEC_CALLEE.source, 'g')),
        ].find(
          (candidate) => !isInsideStringLiteral(line.text, candidate.index),
        );
        if (match) {
          const openParenIndex = match.index + match[0].length - 1;
          const args = extractBalancedArgs(line.text, openParenIndex);
          if (args !== null && hasNonLiteralFirstArg(args)) {
            findings.push({
              lineStart: line.newLine,
              lineEnd: line.newLine,
              snippet: line.text.trim().slice(0, 200),
            });
          }
          continue;
        }
      }

      if (ctx.language === 'py') {
        if (
          matchesAsCode(PY_SUBPROCESS_SHELL_TRUE_PATTERN, line.text) ||
          matchesAsCode(PY_OS_SYSTEM_CALLEE, line.text)
        ) {
          findings.push({
            lineStart: line.newLine,
            lineEnd: line.newLine,
            snippet: line.text.trim().slice(0, 200),
          });
        }
      }
    }
    return findings;
  },
};
