import {
  FindingCategory,
  FindingSource,
  RuleTier,
} from '../../generated/prisma/enums';
import { SYNTAX_RULE_ID } from './syntax/syntax-check';

// The Critical tiers of the quality profile (Rules & Profiles), in the order
// the settings page lists them. An organization turns tiers off; a scan
// snapshots the ones that were on (Scan.ruleTiers) and runs only those.
export const ALL_RULE_TIERS: RuleTier[] = [
  RuleTier.SECRETS,
  RuleTier.CRASH,
  RuleTier.BREAKING_CHANGE,
  RuleTier.ERROR_HANDLING,
  RuleTier.PERFORMANCE,
  RuleTier.SECURITY,
];

// Tiers only the AI review checks: with no AI review on a scan they were
// not looked at, whatever the toggle says.
export const AI_ONLY_TIERS: RuleTier[] = [
  RuleTier.BREAKING_CHANGE,
  RuleTier.PERFORMANCE,
];

const SECURITY_RULES = new Set([
  'code.sql_string_concat',
  'code.shell_injection',
  'code.eval_dynamic',
  'code.insecure_tls',
  'config.cors_wildcard_credentials',
]);

const CRASH_RULES = new Set([SYNTAX_RULE_ID, 'code.debugger_left']);

const ERROR_HANDLING_RULES = new Set(['code.empty_catch']);

// Null for a rule that belongs to no tier — rules.spec.ts makes sure every
// registered rule has one, so a new rule cannot slip past the toggles.
export function tierForRule(ruleId: string): RuleTier | null {
  if (
    ruleId.startsWith('secret.') ||
    ruleId === 'config.dockerfile_root_secret'
  ) {
    return RuleTier.SECRETS;
  }
  if (SECURITY_RULES.has(ruleId)) {
    return RuleTier.SECURITY;
  }
  if (CRASH_RULES.has(ruleId)) {
    return RuleTier.CRASH;
  }
  if (ERROR_HANDLING_RULES.has(ruleId)) {
    return RuleTier.ERROR_HANDLING;
  }
  return null;
}

const CATEGORY_TIER: Partial<Record<FindingCategory, RuleTier>> = {
  [FindingCategory.SECRET]: RuleTier.SECRETS,
  [FindingCategory.CRASH]: RuleTier.CRASH,
  [FindingCategory.CONCURRENCY]: RuleTier.CRASH,
  [FindingCategory.BREAKING_CHANGE]: RuleTier.BREAKING_CHANGE,
  [FindingCategory.ERROR_HANDLING]: RuleTier.ERROR_HANDLING,
  [FindingCategory.PERFORMANCE]: RuleTier.PERFORMANCE,
  [FindingCategory.INJECTION]: RuleTier.SECURITY,
  [FindingCategory.INSECURE_TLS]: RuleTier.SECURITY,
  [FindingCategory.AUTH]: RuleTier.SECURITY,
  [FindingCategory.CONFIG]: RuleTier.SECURITY,
  [FindingCategory.DATA_LOSS]: RuleTier.SECURITY,
};

// Null for LOGIC and OTHER: general review notes, never Critical, shown
// whatever the profile says.
export function tierForCategory(
  category: FindingCategory | null,
): RuleTier | null {
  return category ? (CATEGORY_TIER[category] ?? null) : null;
}

// Static findings belong to their rule's tier, AI findings to their
// category's.
export function tierOfFinding(finding: {
  source: FindingSource;
  ruleId: string;
  category: FindingCategory | null;
}): RuleTier | null {
  return finding.source === FindingSource.STATIC
    ? tierForRule(finding.ruleId)
    : tierForCategory(finding.category);
}

// True when the finding may stay under this set of enabled tiers. A finding
// with no tier always stays.
export function isFindingEnabled(
  finding: Parameters<typeof tierOfFinding>[0],
  enabled: readonly RuleTier[],
): boolean {
  const tier = tierOfFinding(finding);
  return tier === null || enabled.includes(tier);
}

export function enabledTiers(disabled: readonly RuleTier[]): RuleTier[] {
  return ALL_RULE_TIERS.filter((tier) => !disabled.includes(tier));
}

// Order-independent equality, for comparing a scan's snapshot with the
// organization's profile now.
export function sameTiers(
  a: readonly RuleTier[],
  b: readonly RuleTier[],
): boolean {
  return a.length === b.length && a.every((tier) => b.includes(tier));
}

// Canonical form for cache keys: the catalog order, not the stored order.
export function tierKey(tiers: readonly RuleTier[]): string {
  return ALL_RULE_TIERS.filter((tier) => tiers.includes(tier)).join(',');
}
