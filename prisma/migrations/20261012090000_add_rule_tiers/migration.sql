-- Quality profile (Rules & Profiles): the Critical tiers an organization can
-- turn off, and the tiers each scan ran under.
CREATE TYPE "RuleTier" AS ENUM ('SECRETS', 'CRASH', 'BREAKING_CHANGE', 'ERROR_HANDLING', 'PERFORMANCE', 'SECURITY', 'CI');

ALTER TABLE "organizations" ADD COLUMN "disabledRuleTiers" "RuleTier"[] DEFAULT ARRAY[]::"RuleTier"[];
ALTER TABLE "organizations" ADD COLUMN "ruleTiersUpdatedAt" TIMESTAMP(3);
ALTER TABLE "organizations" ADD COLUMN "ruleTiersUpdatedBy" TEXT;

-- Existing scans ran every rule there was, so they are recorded as "all on".
ALTER TABLE "scans" ADD COLUMN "ruleTiers" "RuleTier"[] DEFAULT ARRAY['SECRETS', 'CRASH', 'BREAKING_CHANGE', 'ERROR_HANDLING', 'PERFORMANCE', 'SECURITY', 'CI']::"RuleTier"[];

ALTER TYPE "FullReason" ADD VALUE 'RULES_CHANGED';

-- Categories the AI review files crash-causing bugs and breaking changes
-- under, so each Critical tier has its own.
ALTER TYPE "FindingCategory" ADD VALUE 'CRASH';
ALTER TYPE "FindingCategory" ADD VALUE 'BREAKING_CHANGE';
