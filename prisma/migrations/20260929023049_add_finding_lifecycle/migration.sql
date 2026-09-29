-- CreateEnum
CREATE TYPE "DiffMode" AS ENUM ('FULL', 'INCREMENTAL');

-- CreateEnum
CREATE TYPE "FullReason" AS ENUM ('FIRST_SCAN', 'FORCE_PUSH', 'RULESET_CHANGED', 'PROMPT_CHANGED', 'MANUAL');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('NEW', 'PERSISTED', 'REOPENED', 'RESOLVED');

-- AlterTable
ALTER TABLE "scans" ADD COLUMN     "baseScanId" TEXT,
ADD COLUMN     "diffMode" "DiffMode" NOT NULL DEFAULT 'FULL',
ADD COLUMN     "fullReason" "FullReason",
ADD COLUMN     "newCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "persistedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "prevHeadSha" TEXT,
ADD COLUMN     "reopenedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resolvedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable — pullId/firstSeenScanId start nullable so existing rows can
-- be backfilled before the NOT NULL constraint is applied.
ALTER TABLE "findings" ADD COLUMN     "firstSeenScanId" TEXT,
ADD COLUMN     "originFindingId" TEXT,
ADD COLUMN     "pullId" TEXT,
ADD COLUMN     "resolvedInScanId" TEXT,
ADD COLUMN     "status" "FindingStatus" NOT NULL DEFAULT 'NEW';

-- Backfill: every existing finding was first seen in its own scan and
-- belongs to that scan's PR.
UPDATE "findings" f
SET "pullId" = s."pullId", "firstSeenScanId" = f."scanId"
FROM "scans" s
WHERE s."id" = f."scanId";

ALTER TABLE "findings" ALTER COLUMN "pullId" SET NOT NULL,
ALTER COLUMN "firstSeenScanId" SET NOT NULL;

-- Existing scans were all full scans of the PR's whole diff; their active
-- findings are all NEW.
UPDATE "scans" SET "fullReason" = 'FIRST_SCAN';
UPDATE "scans" s SET "newCount" = c.n
FROM (
  SELECT "scanId", COUNT(*)::int AS n
  FROM "findings"
  WHERE "suppressedReason" IS NULL
  GROUP BY "scanId"
) c
WHERE c."scanId" = s."id";

-- CreateIndex
CREATE INDEX "findings_organizationId_pullId_fingerprint_status_idx" ON "findings"("organizationId", "pullId", "fingerprint", "status");

-- CreateIndex
CREATE INDEX "findings_organizationId_pullId_status_idx" ON "findings"("organizationId", "pullId", "status");

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_baseScanId_fkey" FOREIGN KEY ("baseScanId") REFERENCES "scans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_pullId_fkey" FOREIGN KEY ("pullId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_firstSeenScanId_fkey" FOREIGN KEY ("firstSeenScanId") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_resolvedInScanId_fkey" FOREIGN KEY ("resolvedInScanId") REFERENCES "scans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_originFindingId_fkey" FOREIGN KEY ("originFindingId") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

