-- CI tracking and the quality gate were withdrawn (CLAUDE.md "Hal usang ·
-- CI & quality gate dicabut"). Drops the CI results and the CI tier; the
-- other tiers stay.
DROP TABLE "ci_checks";
DROP TYPE "CiSource";
DROP TYPE "CiState";

-- Postgres cannot drop one enum value: take CI out of every array that holds
-- it, then rebuild RuleTier without it.
UPDATE "scans" SET "ruleTiers" = array_remove("ruleTiers", 'CI');
UPDATE "organizations" SET "disabledRuleTiers" = array_remove("disabledRuleTiers", 'CI');

ALTER TYPE "RuleTier" RENAME TO "RuleTier_old";
CREATE TYPE "RuleTier" AS ENUM ('SECRETS', 'CRASH', 'BREAKING_CHANGE', 'ERROR_HANDLING', 'PERFORMANCE', 'SECURITY');

ALTER TABLE "organizations" ALTER COLUMN "disabledRuleTiers" DROP DEFAULT;
ALTER TABLE "organizations" ALTER COLUMN "disabledRuleTiers" TYPE "RuleTier"[] USING ("disabledRuleTiers"::text[]::"RuleTier"[]);
ALTER TABLE "organizations" ALTER COLUMN "disabledRuleTiers" SET DEFAULT ARRAY[]::"RuleTier"[];

ALTER TABLE "scans" ALTER COLUMN "ruleTiers" DROP DEFAULT;
ALTER TABLE "scans" ALTER COLUMN "ruleTiers" TYPE "RuleTier"[] USING ("ruleTiers"::text[]::"RuleTier"[]);
ALTER TABLE "scans" ALTER COLUMN "ruleTiers" SET DEFAULT ARRAY['SECRETS', 'CRASH', 'BREAKING_CHANGE', 'ERROR_HANDLING', 'PERFORMANCE', 'SECURITY']::"RuleTier"[];

DROP TYPE "RuleTier_old";
