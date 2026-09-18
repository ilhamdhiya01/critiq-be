-- CreateEnum
CREATE TYPE "GithubInstallReturnTo" AS ENUM ('SETUP', 'SETTINGS');

-- AlterEnum
ALTER TYPE "IntegrationState" ADD VALUE 'PENDING_APPROVAL';

-- CreateTable
CREATE TABLE "github_install_intents" (
    "state" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "returnTo" "GithubInstallReturnTo" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_install_intents_pkey" PRIMARY KEY ("state")
);

