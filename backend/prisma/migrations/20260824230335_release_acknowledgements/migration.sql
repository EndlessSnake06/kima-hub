-- CreateEnum
CREATE TYPE "ChoiceDecidedBy" AS ENUM ('EXPLICIT', 'DISMISSED');

-- CreateTable
CREATE TABLE "ReleaseAcknowledgement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseChoice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "decidedBy" "ChoiceDecidedBy" NOT NULL DEFAULT 'DISMISSED',
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReleaseChoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReleaseAcknowledgement_userId_idx" ON "ReleaseAcknowledgement"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseAcknowledgement_userId_version_key" ON "ReleaseAcknowledgement"("userId", "version");

-- CreateIndex
CREATE INDEX "ReleaseChoice_userId_idx" ON "ReleaseChoice"("userId");

-- CreateIndex
CREATE INDEX "ReleaseChoice_key_idx" ON "ReleaseChoice"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseChoice_userId_key_key" ON "ReleaseChoice"("userId", "key");

-- AddForeignKey
ALTER TABLE "ReleaseAcknowledgement" ADD CONSTRAINT "ReleaseAcknowledgement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseChoice" ADD CONSTRAINT "ReleaseChoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
