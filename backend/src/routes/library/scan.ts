import { Router } from "express";
import { requireAdmin } from "../../middleware/auth";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { config } from "../../config";
import { scanQueue } from "../../workers/queues";
import { organizeSingles } from "../../workers/organizeSingles";

const router = Router();

router.post("/scan", requireAdmin, async (req, res) => {
  try {
    if (!config.music.musicPath) {
      return res.status(500).json({
        error:
          "Music path not configured. Please set MUSIC_PATH environment variable.",
      });
    }

    try {
      logger.info("[Scan] Organizing Soulseek downloads before scan...");
      await organizeSingles();
      logger.info("[Scan] Soulseek organization complete");
    } catch (err: any) {
      logger.info("[Scan] Soulseek organization skipped:", err.message);
    }

    const userId = req.user?.id || "system";

    const job = await scanQueue.add("scan", {
      userId,
      musicPath: config.music.musicPath,
    });

    res.json({
      message: "Library scan started",
      jobId: job.id,
      musicPath: config.music.musicPath,
    });
  } catch (error) {
    logger.error("Scan trigger error:", error);
    res.status(500).json({ error: "Failed to start scan" });
  }
});

router.get("/scan/status/:jobId", async (req, res) => {
  try {
    const job = await scanQueue.getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const state = await job.getState();
    const progress = job.progress;
    const result = job.returnvalue;

    res.json({
      status: state,
      progress,
      result,
    });
  } catch (error) {
    logger.error("Get scan status error:", error);
    res.status(500).json({ error: "Failed to get job status" });
  }
});

router.post("/organize", requireAdmin, async (_req, res) => {
  try {
    organizeSingles().catch((err) => {
      logger.error("Manual organization failed:", err);
    });

    res.json({ message: "Organization started in background" });
  } catch (error) {
    logger.error("Organization trigger error:", error);
    res.status(500).json({ error: "Failed to start organization" });
  }
});

router.get("/corrupt-tracks", requireAdmin, async (_req, res) => {
  try {
    const tracks = await prisma.track.findMany({
      where: { corrupt: true },
      include: { album: { include: { artist: { select: { name: true } } } } },
      orderBy: { title: "asc" },
    });

    res.json({
      count: tracks.length,
      tracks: tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.album.artist.name,
        album: t.album.title,
      })),
    });
  } catch (error) {
    logger.error("Get corrupt tracks error:", error);
    res.status(500).json({ error: "Failed to get corrupt tracks" });
  }
});

router.get("/missing-tracks", requireAdmin, async (_req, res) => {
  try {
    // The scan never deletes a track whose file is gone; it flags it with
    // the time it was found missing. This is the true-state listing that
    // decision promises: what is missing, and since when. The flag clears
    // itself on the scan that finds the file again, so there is no clear
    // control here -- clearing it by hand would claim a file is back.
    const tracks = await prisma.track.findMany({
      where: { missingSince: { not: null } },
      include: { album: { include: { artist: { select: { name: true } } } } },
      orderBy: { missingSince: "asc" },
    });

    res.json({
      count: tracks.length,
      tracks: tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.album.artist.name,
        album: t.album.title,
        missingSince: t.missingSince,
      })),
    });
  } catch (error) {
    logger.error("Get missing tracks error:", error);
    res.status(500).json({ error: "Failed to get missing tracks" });
  }
});

router.delete("/corrupt-tracks", requireAdmin, async (_req, res) => {
  try {
    // The old handler ran `deleteMany({ where: { corrupt: true } })`, which
    // deleted real state: the file still exists, the next scan would only
    // re-create the row, and every stage answer recorded against it was
    // lost with it. The operator pressing this means "I know -- re-check
    // it", so we clear the flag and stop. The Track row, its stage
    // records, and any answers already given are kept; the next scan
    // re-answers the file-readable question from the flag.
    const result = await prisma.track.updateMany({
      where: { corrupt: true },
      data: { corrupt: false },
    });
    res.json({
      cleared: result.count,
      message: `Cleared the corrupt flag on ${result.count} tracks (rows kept)`,
    });
  } catch (error) {
    logger.error("Clear corrupt tracks error:", error);
    res.status(500).json({ error: "Failed to clear corrupt tracks" });
  }
});

export default router;
