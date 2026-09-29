-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('SECRET', 'INJECTION', 'INSECURE_TLS', 'ERROR_HANDLING', 'PERFORMANCE', 'LOGIC', 'AUTH', 'CONCURRENCY', 'DATA_LOSS', 'CONFIG', 'OTHER');

-- CreateEnum
CREATE TYPE "AiScanStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'CACHED', 'FAILED', 'SKIPPED_MANUAL_MODE', 'CONSENT_REQUIRED', 'NOT_CONFIGURED', 'SKIPPED_TOO_LARGE', 'BUDGET_EXCEEDED');

-- CreateEnum
CREATE TYPE "AiRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterEnum
ALTER TYPE "SuppressionReason" ADD VALUE 'DEDUPE_STATIC';

-- AlterTable
ALTER TABLE "findings" ADD COLUMN     "category" "FindingCategory",
ADD COLUMN     "confidence" DECIMAL(3,2),
ADD COLUMN     "dedupeOfId" TEXT;

-- AlterTable
ALTER TABLE "pull_requests" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "scans" ADD COLUMN     "aiCached" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiErrorCode" TEXT,
ADD COLUMN     "aiFindingsDeduped" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "aiFindingsRejected" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "aiFindingsTotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "aiFinishedAt" TIMESTAMP(3),
ADD COLUMN     "aiFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "aiModel" TEXT,
ADD COLUMN     "aiPromptVersion" TEXT,
ADD COLUMN     "aiProvider" TEXT,
ADD COLUMN     "aiRawRef" TEXT,
ADD COLUMN     "aiStartedAt" TIMESTAMP(3),
ADD COLUMN     "aiStatus" "AiScanStatus",
ADD COLUMN     "aiTokensIn" INTEGER,
ADD COLUMN     "aiTokensOut" INTEGER,
ADD COLUMN     "majorCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "minorCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ai_summaries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "pullId" TEXT NOT NULL,
    "summaryMd" TEXT NOT NULL,
    "riskLevel" "AiRiskLevel" NOT NULL,
    "filesOmitted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_summaries_scanId_key" ON "ai_summaries"("scanId");

-- CreateIndex
CREATE INDEX "ai_summaries_organizationId_pullId_idx" ON "ai_summaries"("organizationId", "pullId");

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_dedupeOfId_fkey" FOREIGN KEY ("dedupeOfId") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every static finding gets the category AI findings are deduped
-- against (v1.5.1 langkah 2). Must match categoryForRule() in
-- src/queue/finding-category.ts.
UPDATE "findings" SET "category" = CASE
  WHEN "ruleId" LIKE 'secret.%' THEN 'SECRET'::"FindingCategory"
  WHEN "ruleId" IN ('code.sql_string_concat', 'code.shell_injection', 'code.eval_dynamic') THEN 'INJECTION'::"FindingCategory"
  WHEN "ruleId" = 'code.insecure_tls' THEN 'INSECURE_TLS'::"FindingCategory"
  WHEN "ruleId" LIKE 'config.%' THEN 'CONFIG'::"FindingCategory"
  ELSE 'OTHER'::"FindingCategory"
END
WHERE "category" IS NULL AND "source" = 'STATIC';
