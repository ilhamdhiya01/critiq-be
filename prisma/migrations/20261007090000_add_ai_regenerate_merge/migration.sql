-- v1.5.1: an AI re-run on the same commit (same provider, model, prompt) is
-- merged with the earlier run. Where the runs disagree on a finding's
-- severity the higher is kept in "severity" and each run's own is recorded;
-- a finding the latest run no longer reports is kept, flagged.
ALTER TABLE "findings" ADD COLUMN "previousRunSeverity" "FindingSeverity",
ADD COLUMN "latestRunSeverity" "FindingSeverity",
ADD COLUMN "notReproduced" BOOLEAN NOT NULL DEFAULT false;
