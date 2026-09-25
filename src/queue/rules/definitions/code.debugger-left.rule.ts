import { Rule, RuleFinding } from '../rule.interface';

const JS_DEBUGGER_PATTERN = /^\s*debugger;?\s*$/;
const PY_BREAKPOINT_PATTERN = /^\s*(?:breakpoint\(\)|pdb\.set_trace\(\))\s*$/;

export const codeDebuggerLeftRule: Rule = {
  id: 'code.debugger_left',
  severity: 'critical',
  title: 'Debugger breakpoint left in code',
  message:
    'A debugger statement/breakpoint was left in the diff. This halts execution for anyone hitting this code path in the target environment — remove it before merging.',
  languages: ['js', 'py'],
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      const pattern =
        ctx.language === 'py' ? PY_BREAKPOINT_PATTERN : JS_DEBUGGER_PATTERN;
      if (pattern.test(line.text)) {
        findings.push({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          snippet: line.text.trim(),
        });
      }
    }
    return findings;
  },
};
