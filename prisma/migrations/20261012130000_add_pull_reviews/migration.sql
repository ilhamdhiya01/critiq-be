-- v1.5.2: a human's approve / request-changes decision on a PR, and the
-- state of its copy on GitHub/GitLab.
-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVE', 'REQUEST_CHANGES');

-- CreateEnum
CREATE TYPE "ReviewSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "pull_reviews" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pullId" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "body" TEXT,
    "reviewerId" TEXT,
    "reviewerRole" "Role" NOT NULL,
    "effectivePolicy" "ReviewPolicy" NOT NULL,
    "manualConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "syncStatus" "ReviewSyncStatus" NOT NULL DEFAULT 'PENDING',
    "syncError" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pull_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pull_reviews_organizationId_pullId_createdAt_idx" ON "pull_reviews"("organizationId", "pullId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "pull_reviews" ADD CONSTRAINT "pull_reviews_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_reviews" ADD CONSTRAINT "pull_reviews_pullId_fkey" FOREIGN KEY ("pullId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_reviews" ADD CONSTRAINT "pull_reviews_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

