-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ScanTrigger" AS ENUM ('WEBHOOK', 'MANUAL', 'RESCAN');

-- CreateEnum
CREATE TYPE "ScanErrorCode" AS ENUM ('PROVIDER_UNREACHABLE', 'DIFF_TOO_LARGE', 'TIMEOUT', 'RULE_CRASH', 'TOKEN_EXPIRED');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('CRITICAL', 'MAJOR', 'MINOR', 'INFO');

-- CreateEnum
CREATE TYPE "FindingSource" AS ENUM ('STATIC', 'AI');

-- AlterTable
ALTER TABLE "pull_requests" ADD COLUMN     "latestScanId" TEXT;

-- CreateTable
CREATE TABLE "scans" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "pullId" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseSha" TEXT,
    "status" "ScanStatus" NOT NULL,
    "trigger" "ScanTrigger" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "errorCode" "ScanErrorCode",
    "errorMessage" TEXT,
    "diffBytes" INTEGER,
    "filesChanged" INTEGER,
    "findingsCount" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "rulesetVersion" TEXT NOT NULL,
    "findingsTruncated" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "source" "FindingSource" NOT NULL,
    "ruleId" TEXT NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "message" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "lineStart" INTEGER NOT NULL,
    "lineEnd" INTEGER NOT NULL,
    "snippet" TEXT,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scans_organizationId_pullId_createdAt_idx" ON "scans"("organizationId", "pullId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "scans_repositoryId_pullId_headSha_attempt_key" ON "scans"("repositoryId", "pullId", "headSha", "attempt");

-- CreateIndex
CREATE INDEX "findings_organizationId_scanId_idx" ON "findings"("organizationId", "scanId");

-- CreateIndex
CREATE INDEX "findings_scanId_filePath_lineStart_idx" ON "findings"("scanId", "filePath", "lineStart");

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_latestScanId_fkey" FOREIGN KEY ("latestScanId") REFERENCES "scans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_pullId_fkey" FOREIGN KEY ("pullId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
