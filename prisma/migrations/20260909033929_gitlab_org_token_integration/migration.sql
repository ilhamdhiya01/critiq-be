/*
  Warnings:

  - You are about to drop the `gitlab_connections` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `repositories` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('GROUP_TOKEN', 'OAUTH');

-- CreateEnum
CREATE TYPE "TokenKind" AS ENUM ('GROUP', 'PERSONAL');

-- CreateEnum
CREATE TYPE "IntegrationState" AS ENUM ('ACTIVE', 'EXPIRING_SOON', 'TOKEN_EXPIRED', 'INVALID');

-- DropForeignKey
ALTER TABLE "gitlab_connections" DROP CONSTRAINT "gitlab_connections_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_gitlabConnectionId_fkey";

-- DropForeignKey
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_organizationId_fkey";

-- DropTable
DROP TABLE "gitlab_connections";

-- DropTable
DROP TABLE "repositories";

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" "Provider" NOT NULL,
    "instanceUrl" TEXT NOT NULL,
    "credentialKind" "CredentialKind" NOT NULL DEFAULT 'GROUP_TOKEN',
    "encryptedToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tokenKind" "TokenKind" NOT NULL,
    "tokenUsername" TEXT NOT NULL,
    "groupsCache" JSONB,
    "state" "IntegrationState" NOT NULL DEFAULT 'ACTIVE',
    "connectedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integrations_organizationId_source_key" ON "integrations"("organizationId", "source");

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_connectedByUserId_fkey" FOREIGN KEY ("connectedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
