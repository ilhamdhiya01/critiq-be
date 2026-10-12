-- v1.5.2: PR comments, synced both ways with GitHub/GitLab.
-- CreateEnum
CREATE TYPE "CommentOrigin" AS ENUM ('CRITIQ', 'GITHUB', 'GITLAB');

-- CreateEnum
CREATE TYPE "CommentKind" AS ENUM ('GENERAL', 'INLINE');

-- CreateEnum
CREATE TYPE "DiffSide" AS ENUM ('NEW', 'OLD');

-- CreateEnum
CREATE TYPE "CommentSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "pull_comments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pullId" TEXT NOT NULL,
    "origin" "CommentOrigin" NOT NULL,
    "kind" "CommentKind" NOT NULL,
    "parentId" TEXT,
    "authorId" TEXT,
    "providerAuthor" TEXT,
    "providerAuthorAvatarUrl" TEXT,
    "body" TEXT NOT NULL,
    "path" TEXT,
    "line" INTEGER,
    "side" "DiffSide",
    "headSha" TEXT,
    "providerCommentId" TEXT,
    "providerThreadId" TEXT,
    "syncStatus" "CommentSyncStatus",
    "syncError" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pull_comments_organizationId_pullId_createdAt_idx" ON "pull_comments"("organizationId", "pullId", "createdAt");

-- CreateIndex
CREATE INDEX "pull_comments_pullId_providerThreadId_idx" ON "pull_comments"("pullId", "providerThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "pull_comments_pullId_providerCommentId_key" ON "pull_comments"("pullId", "providerCommentId");

-- AddForeignKey
ALTER TABLE "pull_comments" ADD CONSTRAINT "pull_comments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_comments" ADD CONSTRAINT "pull_comments_pullId_fkey" FOREIGN KEY ("pullId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_comments" ADD CONSTRAINT "pull_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_comments" ADD CONSTRAINT "pull_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "pull_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

