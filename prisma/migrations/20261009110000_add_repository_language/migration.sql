-- Main language of a repository as the provider reports it (display only).
-- Null languageCheckedAt = not asked yet; the worker fills it on the next scan.
ALTER TABLE "repositories" ADD COLUMN "language" TEXT,
ADD COLUMN "languageCheckedAt" TIMESTAMP(3);
