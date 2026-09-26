import { Rule } from './rule.interface';
import { secretAwsAccessKeyRule } from './definitions/secret.aws-access-key.rule';
import { secretAssignmentLiteralRule } from './definitions/secret.assignment-literal.rule';
import { secretPrivateKeyBlockRule } from './definitions/secret.private-key-block.rule';
import { secretSensitiveFileAddedRule } from './definitions/secret.sensitive-file-added.rule';
import { providerTokenRules } from './definitions/provider-token.rules';
import { secretHighEntropyStringRule } from './definitions/secret.high-entropy-string.rule';
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
  secretAssignmentLiteralRule,
  secretPrivateKeyBlockRule,
  secretSensitiveFileAddedRule,
  secretHardcodedPasswordRule,
  secretGithubTokenRule,
  secretGitlabTokenRule,
  secretSlackWebhookRule,
  secretJwtLiteralRule,
  secretDbUrlWithPasswordRule,
  // Fixed-prefix provider credentials, built from one factory — see
  // provider-token.rules.ts for why they are not fourteen separate files.
  ...providerTokenRules,
  // Last of the secret rules on purpose: it is the broadest, and every
  // narrower rule above has already claimed what it recognises.
  secretHighEntropyStringRule,
  codeEvalDynamicRule,
  codeSqlStringConcatRule,
  codeShellInjectionRule,
  codeInsecureTlsRule,
  codeDebuggerLeftRule,
  configDockerfileRootSecretRule,
  configCorsWildcardCredentialsRule,
];
