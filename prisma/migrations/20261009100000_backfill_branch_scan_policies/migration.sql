-- A branch added to a repo's scan scope after connect (PUT …/scan-config)
-- got no review policy row, so its pull requests fell back to MANUAL_ONLY
-- and the AI review never ran. Give every in-scope branch without a row the
-- policy of its repository's default branch (MANUAL_ONLY when even that is
-- missing — the same fallback the PR already got). Data only; idempotent.
--
-- The column has no database default (Prisma generates cuids client-side),
-- so backfilled ids are UUIDs: a different shape, still a unique text key.
INSERT INTO "branch_scan_policies"
  ("id", "organizationId", "repositoryId", "branch", "policy", "updatedAt")
SELECT
  gen_random_uuid()::text,
  c."organizationId",
  c."repositoryId",
  b.branch,
  COALESCE(d."policy", 'MANUAL_ONLY'::"ReviewPolicy"),
  CURRENT_TIMESTAMP
FROM "repo_scan_configs" c
-- DISTINCT: a scope array could hold the same branch twice (no dedupe
-- before this release), and the unique index would reject the second row.
CROSS JOIN LATERAL (SELECT DISTINCT unnest(c."branches") AS branch) b
LEFT JOIN "branch_scan_policies" d
  ON d."repositoryId" = c."repositoryId" AND d."branch" = c."defaultBranch"
WHERE NOT EXISTS (
  SELECT 1 FROM "branch_scan_policies" p
  WHERE p."repositoryId" = c."repositoryId" AND p."branch" = b.branch
);
