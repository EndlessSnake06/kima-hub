import { Worker, Job } from "bullmq";
import { createWorkerConnection, QUEUE_NAMES } from "./enrichmentQueues";
import { enrichSimilarArtist, failedArtistStatus } from "./artistEnrichment";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";

interface ArtistJobData {
    artistId: string;
    artistName: string;
}

export async function startArtistEnrichmentWorker(): Promise<Worker> {
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency ?? 3;

    const worker = new Worker<ArtistJobData>(
        QUEUE_NAMES.ARTISTS,
        async (job: Job<ArtistJobData>) => {
            const { artistId, artistName } = job.data;
            logger.debug(`[ArtistWorker] Processing ${artistId} (${artistName})`);

            const artist = await prisma.artist.findUnique({ where: { id: artistId } });
            if (!artist) {
                const err = new Error(`ENTITY_NOT_FOUND: Artist ${artistId} deleted`);
                (err as any).entityNotFound = true;
                throw err;
            }

            // enrichSimilarArtist records the artist's status: completed, or failed and
            // counted toward unresolvable.
            await enrichSimilarArtist(artist);
        },
        {
            connection: createWorkerConnection(),
            concurrency,
            lockDuration: 120000,
            stalledInterval: 30000,
            maxStalledCount: 2,
        },
    );

    worker.on("failed", async (job, err) => {
        if (!job) return;
        const { artistId } = job.data;
        const isEntityGone = (err as any).entityNotFound === true;

        if (isEntityGone) {
            logger.info(`[ArtistWorker] Artist ${artistId} no longer exists, resolving silently`);
            return;
        }

        logger.error(`[ArtistWorker] Artist ${artistId} failed: ${err.message}`);

        // enrichSimilarArtist records its own failures; one that threw before it could
        // (still pending or enriching) is recorded here the same way.
        try {
            const artist = await prisma.artist.findUnique({
                where: { id: artistId },
                select: { enrichmentStatus: true, enrichmentFailures: true },
            });
            if (artist && (artist.enrichmentStatus === "pending" || artist.enrichmentStatus === "enriching")) {
                await prisma.artist.update({
                    where: { id: artistId },
                    data: failedArtistStatus(artist.enrichmentFailures),
                });
            }
            await enrichmentFailureService.recordFailure({
                entityType: "artist",
                entityId: artistId,
                entityName: job.data.artistName,
                errorMessage: err.message,
            });
        } catch (reportErr) {
            logger.warn(`[ArtistWorker] Could not record artist ${artistId}'s failure: ${(reportErr as Error).message}`);
        }
    });

    worker.on("error", (err) => logger.error(`[ArtistWorker] Error: ${err.message}`));
    logger.info(`[ArtistWorker] Started (concurrency: ${concurrency})`);
    return worker;
}
