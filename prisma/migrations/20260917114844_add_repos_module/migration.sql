-- CreateEnum
CREATE TYPE "ReviewPolicy" AS ENUM ('MANUAL_ONLY', 'ALLOW_AI', 'REQUIRE_BOTH');

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repo_scan_configs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "branches" TEXT[],
    "defaultBranchChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_scan_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_scan_policies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "policy" "ReviewPolicy" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_scan_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repositories_organizationId_idx" ON "repositories"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_integrationId_externalId_key" ON "repositories"("integrationId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "repo_scan_configs_repositoryId_key" ON "repo_scan_configs"("repositoryId");

-- CreateIndex
CREATE INDEX "repo_scan_configs_organizationId_repositoryId_idx" ON "repo_scan_configs"("organizationId", "repositoryId");

-- CreateIndex
CREATE INDEX "branch_scan_policies_organizationId_idx" ON "branch_scan_policies"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "branch_scan_policies_repositoryId_branch_key" ON "branch_scan_policies"("repositoryId", "branch");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_scan_configs" ADD CONSTRAINT "repo_scan_configs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_scan_configs" ADD CONSTRAINT "repo_scan_configs_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_scan_policies" ADD CONSTRAINT "branch_scan_policies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_scan_policies" ADD CONSTRAINT "branch_scan_policies_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

