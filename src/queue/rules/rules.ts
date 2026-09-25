import { Rule } from './rule.interface';
import { secretAwsAccessKeyRule } from './definitions/secret.aws-access-key.rule';
import { secretGenericApiKeyRule } from './definitions/secret.generic-api-key.rule';
import { secretPrivateKeyBlockRule } from './definitions/secret.private-key-block.rule';
import { secretHardcodedPasswordRule } from './definitions/secret.hardcoded-password.rule';
import { secretGithubTokenRule } from './definitions/secret.github-token.rule';
import { secretGitlabTokenRule } from './definitions/secret.gitlab-token.rule';
import { secretSlackWebhookRule } from './definitions/secret.slack-webhook.rule';
import { secretJwtLiteralRule } from './definitions/secret.jwt-literal.rule';
import { secretDbUrlWithPasswordRule } from './definitions/secret.db-url-with-password.rule';
import { codeEvalDynamicRule } from './definitions/code.eval-dynamic.rule';
import { codeSqlStringConcatRule } from './definitions/code.sql-string-concat.rule';
import { codeShellInjectionRule } from './definitions/code.shell-injection.rule';
import { codeInsecureTlsRule } from './definitions/code.insecure-tls.rule';
import { codeDebuggerLeftRule } from './definitions/code.debugger-left.rule';
import { configDockerfileRootSecretRule } from './definitions/config.dockerfile-root-secret.rule';
import { configCorsWildcardCredentialsRule } from './definitions/config.cors-wildcard-credentials.rule';

// Adding a rule = adding a definition file + fixtures + this one import/
// array entry — no processor code (ScanProcessor, Checkpoint D) needs to
// change, since it always iterates this flat list.
export const RULES: Rule[] = [
  secretAwsAccessKeyRule,
  secretGenericApiKeyRule,
  secretPrivateKeyBlockRule,
  secretHardcodedPasswordRule,
  secretGithubTokenRule,
  secretGitlabTokenRule,
  secretSlackWebhookRule,
  secretJwtLiteralRule,
  secretDbUrlWithPasswordRule,
  codeEvalDynamicRule,
  codeSqlStringConcatRule,
  codeShellInjectionRule,
  codeInsecureTlsRule,
  codeDebuggerLeftRule,
  configDockerfileRootSecretRule,
  configCorsWildcardCredentialsRule,
];
