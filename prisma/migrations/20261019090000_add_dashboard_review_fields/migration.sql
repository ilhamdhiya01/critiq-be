-- Dashboard (19 Oct 2026): review turnaround and AI-assisted vs manual.

-- When the PR was opened on the provider. Filled from the next webhook of
-- each PR; until then the dashboard falls back to "createdAt".
ALTER TABLE "pull_requests" ADD COLUMN "openedAt" TIMESTAMP(3);

-- Snapshot taken when the reviewer decided: the AI review of that very
-- commit was done.
ALTER TABLE "pull_reviews" ADD COLUMN "aiAssisted" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: a scan of the reviewed commit whose AI review had finished
-- (DONE/CACHED) before the decision.
UPDATE "pull_reviews" r
SET "aiAssisted" = true
WHERE EXISTS (
  SELECT 1
  FROM "scans" s
  WHERE s."pullId" = r."pullId"
    AND s."headSha" = r."headSha"
    AND s."aiStatus" IN ('DONE', 'CACHED')
    AND s."aiFinishedAt" IS NOT NULL
    AND s."aiFinishedAt" <= r."createdAt"
);
