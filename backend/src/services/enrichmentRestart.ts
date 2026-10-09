/**
 * Wipe and re-run the library's enrichment: clears which recording each track is (with its ISRC and genres), artist
 * bios, genres and similar artists, every analysis and sound vector, and the similarity step's feel, statistics and
 * map, then runs the five steps again. Artists keep their MusicBrainz id until the artist step checks it. Keeps the
 * library, fingerprints, artist images, questions closed for good or decided by a person, and everything people made.
 */
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { trackQueue, vibeQueue } from "../workers/enrichmentQueues";
import { STAGE_QUEUES } from "../workers/unifiedEnrichment";
import { closeStagesForMissingTracks } from "./missingFileStages";

export interface EnrichmentWipe {
    artists: number;
    tracks: number;
    vectors: number;
}

export async function wipeEnrichment(): Promise<EnrichmentWipe> {
    // Queued jobs go first, then every open record is reset, the claimed ones too. A job claimed
    // before the reset holds a claim that no longer matches and is refused when it reports; one
    // claimed after it is a real claim. Emptying the queues after the reset would drop real jobs
    // and leave their records claimed until the lease ran out.
    await redisClient.del(STAGE_QUEUES.analysis);
    await vibeQueue.drain();
    await trackQueue.drain();
    return prisma.$transaction(
        async (tx) => {
            // A step a person set aside for a track stays as they left it.
            const vectors = await tx.$executeRaw`
                DELETE FROM track_embeddings e
                WHERE NOT EXISTS (SELECT 1 FROM "TrackStage" s
                                  WHERE s."trackId" = e.track_id AND s.stage = 'embedding' AND s."decidedAt" IS NOT NULL)
            `;
            await tx.$executeRaw`DELETE FROM matching_state`;
            await tx.$executeRaw`DELETE FROM "SimilarArtist"`;
            const artists = await tx.$executeRaw`
                UPDATE "Artist"
                SET summary = NULL, genres = NULL, "similarArtistsJson" = NULL,
                    "lastEnriched" = NULL, "enrichmentStatus" = 'pending', "enrichmentFailures" = 0
            `;
            const tracks = await tx.$executeRaw`
                UPDATE "Track"
                SET bpm = NULL, "beatsCount" = NULL, key = NULL, "keyScale" = NULL, "keyStrength" = NULL,
                    energy = NULL, loudness = NULL, "dynamicRange" = NULL, danceability = NULL,
                    valence = NULL, arousal = NULL, "deamValence" = NULL, "deamArousal" = NULL,
                    "clapValenceRaw" = NULL, "clapArousalRaw" = NULL,
                    instrumentalness = NULL, acousticness = NULL, speechiness = NULL,
                    "moodHappy" = NULL, "moodSad" = NULL, "moodRelaxed" = NULL, "moodAggressive" = NULL,
                    "moodParty" = NULL, "moodAcoustic" = NULL, "moodElectronic" = NULL, "danceabilityMl" = NULL,
                    "moodTags" = '{}', "essentiaGenres" = '{}',
                    "analysisStatus" = 'pending', "analysisVersion" = NULL, "analysisMode" = NULL,
                    "analyzedAt" = NULL, "analysisError" = NULL, "analysisRetryCount" = 0, "analysisStartedAt" = NULL
                WHERE NOT EXISTS (SELECT 1 FROM "TrackStage" s
                                  WHERE s."trackId" = "Track".id AND s.stage = 'analysis' AND s."decidedAt" IS NOT NULL)
            `;
            await tx.$executeRaw`
                UPDATE "Track"
                SET "vibeAnalysisStatus" = 'pending', "vibeAnalysisStartedAt" = NULL, "vibeAnalysisError" = NULL,
                    "vibeAnalysisRetryCount" = 0, "vibeAnalysisStatusUpdatedAt" = NULL
                WHERE NOT EXISTS (SELECT 1 FROM "TrackStage" s
                                  WHERE s."trackId" = "Track".id AND s.stage = 'embedding' AND s."decidedAt" IS NOT NULL)
            `;
            await tx.$executeRaw`
                UPDATE "TrackStage"
                SET status = 'pending', failures = 0, redelivered = 0, "lastErrorCode" = NULL,
                    "lastErrorMessage" = NULL, "failureClass" = NULL, retryable = true, "nextRetryAt" = NULL,
                    evidence = NULL, "startedAt" = NULL, "finishedAt" = NULL
                WHERE stage IN ('analysis', 'embedding') AND "decidedAt" IS NULL
            `;
            // Identification is asked again where it was answered or is being asked; a question
            // closed for good or decided by a person stays as it is.
            await tx.$executeRaw`
                WITH reopened AS (
                    UPDATE "TrackStage"
                    SET status = 'pending', failures = 0, redelivered = 0, retryable = true, "nextRetryAt" = NULL,
                        evidence = jsonb_build_object('reason', 'enrichment wiped'), "startedAt" = NULL, "finishedAt" = NULL
                    WHERE stage = 'recording' AND status IN ('done', 'working') AND "decidedAt" IS NULL
                    RETURNING "trackId"
                ), cleared AS (
                    DELETE FROM "TrackGenre" WHERE "trackId" IN (SELECT "trackId" FROM reopened) RETURNING 1
                )
                UPDATE "Track" t
                SET "recordingMbid" = NULL,
                    isrc = CASE WHEN t."isrcSource" = 'musicbrainz' THEN NULL ELSE t.isrc END,
                    "isrcSource" = CASE WHEN t."isrcSource" = 'musicbrainz' THEN NULL ELSE t."isrcSource" END
                FROM reopened r WHERE t.id = r."trackId"
            `;
            // A file that is gone cannot be re-run; its records wait for a scan to find it.
            await closeStagesForMissingTracks(tx);
            await tx.$executeRaw`DELETE FROM "EnrichmentFailure" WHERE "entityType" IN ('artist', 'audio', 'vibe')`;
            return { artists, tracks, vectors };
        },
        { timeout: 120_000 },
    );
}
