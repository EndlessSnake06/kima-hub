-- CreateTable
CREATE TABLE "PlayAuditIgnore" (
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "ignoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayAuditIgnore_pkey" PRIMARY KEY ("userId","trackId")
);

-- CreateIndex
CREATE INDEX "PlayAuditIgnore_userId_idx" ON "PlayAuditIgnore"("userId");

-- AddForeignKey
ALTER TABLE "PlayAuditIgnore" ADD CONSTRAINT "PlayAuditIgnore_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayAuditIgnore" ADD CONSTRAINT "PlayAuditIgnore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

