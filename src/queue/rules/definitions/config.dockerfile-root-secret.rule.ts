import { Rule, RuleFinding } from '../rule.interface';

const ENV_SECRET_PATTERN =
  /^\s*ENV\s+.*(PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*\S{8,}/i;

export const configDockerfileRootSecretRule: Rule = {
  id: 'config.dockerfile_root_secret',
  severity: 'critical',
  title: 'Secret baked into Dockerfile ENV instruction',
  message:
    'This ENV instruction bakes a credential-shaped value directly into the image layer, where it is readable by anyone who can pull or inspect the image. Pass secrets at runtime (--env-file, orchestrator secrets, a secrets manager) instead of baking them into the build.',
  languages: ['dockerfile'],
  test(ctx) {
    const findings: RuleFinding[] = [];
    for (const line of ctx.addedLines) {
      if (ENV_SECRET_PATTERN.test(line.text)) {
        findings.push({
          lineStart: line.newLine,
          lineEnd: line.newLine,
          snippet: null,
        });
      }
    }
    return findings;
  },
};
