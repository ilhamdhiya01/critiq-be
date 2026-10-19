-- Activity (19 Oct 2026): the org's reviews newest first, one keyset page at
-- a time. The existing index starts with pullId and cannot serve it.
CREATE INDEX "pull_reviews_organizationId_createdAt_id_idx" ON "pull_reviews"("organizationId", "createdAt" DESC, "id" DESC);
