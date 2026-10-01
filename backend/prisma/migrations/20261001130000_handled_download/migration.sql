-- Each Lidarr download Kima removes is recorded once, so a second remover or Lidarr's echo does nothing.
CREATE TABLE IF NOT EXISTS "HandledDownload" (
    "downloadId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandledDownload_pkey" PRIMARY KEY ("downloadId")
);
