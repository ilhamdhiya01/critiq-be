import { isCommentLine } from '../line-context';
import { Rule, RuleFinding } from '../rule.interface';

// Matches a SQL keyword inside a string that is being concatenated with a
// variable — either classic `'... ' + var` concatenation or a template
// literal with `${...}` interpolation — when the whole thing looks like it
// feeds a query/execute/raw call. This is a line-local heuristic (the
// call and the concatenation must appear on the same added line), which
// keeps it simple at the cost of missing multi-line-built queries — an
// accepted trade-off for a diff-only, line-based rule engine.
const SQL_KEYWORD = /(SELECT|INSERT|UPDATE|DELETE)\b/i;
const CONCAT_WITH_VARIABLE = /['"]\s*\+\s*\w+|\$\{[^}]+\}/;
const QUERY_CALL = /\b(query|execute|raw)\s*\(/i;

export const codeSqlStringConcatRule: Rule = {
  id: 'code.sql_string_concat',
  severity: 'critical',
  title: 'SQL query built via string concatenation',
  message:
    "Building a SQL query by concatenating a variable directly into the query string is a SQL injection risk. Use parameterized queries / prepared statements (or your ORM/query builder's parameter binding) instead of string concatenation.",
  languages: ['js', 'py', 'go', 'php'],
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      // Comments only. The string-literal check other code.* rules use
      // can't apply here: the SQL itself always lives inside a string.
      if (isCommentLine(line.text)) {
        continue;
      }
      if (
        SQL_KEYWORD.test(line.text) &&
        CONCAT_WITH_VARIABLE.test(line.text) &&
        QUERY_CALL.test(line.text)
      ) {
        findings.push({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          snippet: line.text.trim().slice(0, 200),
        });
      }
    }
    return findings;
  },
};
