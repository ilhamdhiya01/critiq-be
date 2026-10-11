-- CI results reported by the code host per commit (Failing CI tier).
CREATE TYPE "CiSource" AS ENUM ('GITHUB_CHECK_RUN', 'GITHUB_STATUS', 'GITLAB_PIPELINE');

CREATE TYPE "CiState" AS ENUM ('PENDING', 'SUCCESS', 'FAILURE');

CREATE TABLE "ci_checks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "source" "CiSource" NOT NULL,
    "name" TEXT NOT NULL,
    "state" "CiState" NOT NULL,
    "url" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ci_checks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ci_checks_repositoryId_headSha_source_name_key" ON "ci_checks"("repositoryId", "headSha", "source", "name");

CREATE INDEX "ci_checks_organizationId_repositoryId_headSha_idx" ON "ci_checks"("organizationId", "repositoryId", "headSha");

ALTER TABLE "ci_checks" ADD CONSTRAINT "ci_checks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ci_checks" ADD CONSTRAINT "ci_checks_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
