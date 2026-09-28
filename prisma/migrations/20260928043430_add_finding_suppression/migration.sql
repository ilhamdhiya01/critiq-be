-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('TEST_FILE', 'REGEX_LITERAL');

-- AlterTable
ALTER TABLE "findings" ADD COLUMN     "suppressedReason" "SuppressionReason";

-- AlterTable
ALTER TABLE "scans" ADD COLUMN     "suppressedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "suppressedTruncated" BOOLEAN NOT NULL DEFAULT false;
