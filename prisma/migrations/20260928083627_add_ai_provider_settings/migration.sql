-- CreateEnum
CREATE TYPE "AiProviderId" AS ENUM ('ANTHROPIC', 'OPENAI', 'OPENAI_COMPATIBLE');

-- CreateEnum
CREATE TYPE "AiUsageKind" AS ENUM ('SCAN', 'TEST');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "aiConsentAt" TIMESTAMP(3),
ADD COLUMN     "aiConsentBy" TEXT,
ADD COLUMN     "aiDailyTokenBudget" INTEGER NOT NULL DEFAULT 2000000,
ADD COLUMN     "aiLastTest" JSONB,
ADD COLUMN     "aiLocale" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "aiModel" TEXT,
ADD COLUMN     "aiProvider" "AiProviderId";

-- CreateTable
CREATE TABLE "ai_credentials" (
    "organizationId" TEXT NOT NULL,
    "provider" "AiProviderId" NOT NULL,
    "encryptedKey" TEXT,
    "keyLast4" VARCHAR(4),
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "baseUrl" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_credentials_pkey" PRIMARY KEY ("organizationId","provider")
);

-- CreateTable
CREATE TABLE "ai_usage_daily" (
    "organizationId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "kind" "AiUsageKind" NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_daily_pkey" PRIMARY KEY ("organizationId","day","kind")
);

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_aiConsentBy_fkey" FOREIGN KEY ("aiConsentBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
