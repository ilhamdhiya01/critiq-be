-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "encryptedWebhookSecret" TEXT,
ADD COLUMN     "gitlabWebhookId" INTEGER;

