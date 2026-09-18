-- CreateTable
CREATE TABLE "gitlab_connections" (
    "id" TEXT NOT NULL,
    "instanceUrl" TEXT NOT NULL,
    "encryptedPat" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gitlab_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "webhookId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gitlabConnectionId" TEXT,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repositories_provider_externalId_key" ON "repositories"("provider", "externalId");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_gitlabConnectionId_fkey" FOREIGN KEY ("gitlabConnectionId") REFERENCES "gitlab_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
