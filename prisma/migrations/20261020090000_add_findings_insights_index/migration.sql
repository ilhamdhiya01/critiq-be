-- Insights (20 Oct 2026): an organization's criticals by status over time.
-- The existing findings indexes start with scanId or pullId.
CREATE INDEX "findings_organizationId_severity_status_createdAt_idx" ON "findings"("organizationId", "severity", "status", "createdAt");
