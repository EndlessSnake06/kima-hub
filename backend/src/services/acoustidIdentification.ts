/**
 * AcoustID-first track identification.
 *
 * AcoustID is the primary identity source,
 * MusicBrainz text search is the fallback. Resolution order implemented here:
 *
 *   1. acoustid_id / acoustid_fingerprint tags already in the file — a
 *      previous tool may have stamped them; the id needs no network call.
 *   2. An existing fingerprint tag, or a fresh fpcalc fingerprint, run
 *      through the AcoustID lookup.
 *   3. null return — the caller falls back to the MusicBrainz search.
 *
 * Every terminal outcome is counted in kima_acoustid_track_identity_total
 * (labels path/outcome) so the resolution mix is observable per run.
 */

import { parseFile } from "music-metadata";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { acoustidTrackIdentityTotal } from "../utils/metrics";
import { acoustidService, AcoustIDResult } from "./acoustidService";
import { fpcalcService } from "./fpcalc";

export interface TrackIdentification {
    source: "file_tag" | "fpcalc";
    recordingMbid: string;
    artistMbid?: string;
    releaseGroupMbid?: string;
    /** The fingerprint behind the match, when one was available. */
    fingerprint?: string;
}

/** Track columns the identifier reads. */
export interface IdentifiableTrack {
    id: string;
    title: string;
    filePath: string;
    duration: number;
}

/** Tag values may arrive as a string or a single-element array. */
function firstTag(value: unknown): string | null {
    if (!value) return null;
    const v = Array.isArray(value) ? value[0] : value;
    return typeof v === "string" && v.length > 0 ? v : null;
}

function toIdentification(result: AcoustIDResult): Omit<
    TrackIdentification,
    "source" | "fingerprint"
> {
    return {
        recordingMbid: result.recordingMbid,
        artistMbid: result.artistMbid || undefined,
        releaseGroupMbid: result.releaseGroupMbid || undefined,
    };
}

/**
 * Identify a track AcoustID-first. Never throws: identification is
 * best-effort and a null return simply means "use the fallback".
 */
export async function identifyTrackByAcoustid(
    track: IdentifiableTrack
): Promise<TrackIdentification | null> {
    // Path 1+2a: what the file itself already knows.
    try {
        const metadata = await parseFile(track.filePath);
        const common = metadata.common as Record<string, unknown>;
        const tagId = firstTag(common.acoustid_id);
        const tagFingerprint = firstTag(common.acoustid_fingerprint);
        const duration =
            track.duration > 0
                ? track.duration
                : Math.floor(metadata.format.duration || 0);

        if (tagId) {
            acoustidTrackIdentityTotal.inc({
                path: "file_tag",
                outcome: "resolved",
            });
            return {
                source: "file_tag",
                recordingMbid: tagId,
                fingerprint: tagFingerprint || undefined,
            };
        }

        if (tagFingerprint) {
            const result = await acoustidService.lookup(
                duration,
                tagFingerprint
            );
            if (result) {
                acoustidTrackIdentityTotal.inc({
                    path: "file_tag",
                    outcome: "resolved",
                });
                return {
                    source: "file_tag",
                    ...toIdentification(result),
                    fingerprint: tagFingerprint,
                };
            }
            acoustidTrackIdentityTotal.inc({
                path: "file_tag",
                outcome: "no_match",
            });
        }
    } catch (err: any) {
        logger.debug(
            `[AcoustID] Tag read failed for ${track.filePath}: ${err?.message}`
        );
        acoustidTrackIdentityTotal.inc({ path: "file_tag", outcome: "error" });
    }

    // Path 2b: compute a fingerprint and query AcoustID.
    if (!(await fpcalcService.isAvailable())) {
        acoustidTrackIdentityTotal.inc({ path: "fpcalc", outcome: "skipped" });
        return null;
    }
    const fp = await fpcalcService.fingerprintFile(track.filePath);
    if (!fp) {
        acoustidTrackIdentityTotal.inc({ path: "fpcalc", outcome: "error" });
        return null;
    }
    const result = await acoustidService.lookup(fp.duration, fp.fingerprint);
    if (!result) {
        acoustidTrackIdentityTotal.inc({ path: "fpcalc", outcome: "no_match" });
        return null;
    }
    acoustidTrackIdentityTotal.inc({ path: "fpcalc", outcome: "resolved" });
    return {
        source: "fpcalc",
        ...toIdentification(result),
        fingerprint: fp.fingerprint,
    };
}

/**
 * Persist the fingerprint behind an identification for intra-library
 * duplicate/version detection. Errors are logged, never thrown — the
 * identification itself already succeeded at this point.
 */
export async function persistAcoustidFingerprint(
    trackId: string,
    fingerprint: string
): Promise<void> {
    try {
        await prisma.track.update({
            where: { id: trackId },
            data: { acoustidFingerprint: fingerprint },
        });
    } catch (err: any) {
        logger.warn(
            `[AcoustID] Failed to persist fingerprint for ${trackId}: ${err?.message}`
        );
    }
}
