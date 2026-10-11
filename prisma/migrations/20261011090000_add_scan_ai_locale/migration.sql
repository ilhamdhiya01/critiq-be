-- The organization language an AI review was written in, so a cached or
-- earlier result in another language is never reused. Null = recorded before
-- this column existed.
ALTER TABLE "scans" ADD COLUMN "aiLocale" TEXT;
