-- AlterEnum
ALTER TYPE "CredentialKind" ADD VALUE 'INSTALLATION';

-- AlterTable
ALTER TABLE "integrations" ADD COLUMN     "appSlug" TEXT,
ADD COLUMN     "installationId" TEXT,
ADD COLUMN     "installationLogin" TEXT,
ALTER COLUMN "instanceUrl" DROP NOT NULL,
ALTER COLUMN "encryptedToken" DROP NOT NULL,
ALTER COLUMN "expiresAt" DROP NOT NULL,
ALTER COLUMN "tokenKind" DROP NOT NULL,
ALTER COLUMN "tokenUsername" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "integrations_installationId_key" ON "integrations"("installationId");

