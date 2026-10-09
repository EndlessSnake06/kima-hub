/**
 * The file's own identity tags, and AcoustID with the tagged or stored
 * fingerprint: the first and last steps of track identification. fpcalc never
 * runs here. An `acoustid_id` tag names a fingerprint cluster, not a recording,
 * so it is never a recordingMbid.
 */

import { parseFile } from "music-metadata";
import { prisma } from "../utils/db";
import { resolveTrackFilePath } from "../routes/library/trackPath";
import { logger } from "../utils/logger";
import { acoustidTrackIdentityTotal } from "../utils/metrics";
import {
    Outcome,
    answered,
    absent,
} from "../utils/outcome";
import { acoustidService, AcoustIDResult } from "./acoustidService";

/** Track columns the identifier reads. */
export interface IdentifiableTrack {
    id: string;
    title: string;
    /** `Track.filePath` as stored: relative to the music folder. */
    filePath: string;
    duration: number;
}

/** What the file's own tags say, read without any network call. */
export interface IdentityTags {
    /** A `musicbrainz_recordingid` tag, or null when the file has none. */
    recordingMbid: string | null;
    /** An `acoustid_fingerprint` tag, or null when the file has none. */
    fingerprint: string | null;
    /** The track's own artist tags (not the album artist): who the track is credited to. */
    artists: string[];
    /** `track.duration`, or the file's own duration when that is unset. */
    duration: number;
}

export interface TrackIdentification {
    /** `file_tag`: the file's recording id tag; `acoustid`: an AcoustID fingerprint match. */
    source: "file_tag" | "acoustid";
    /** For an AcoustID answer, where its fingerprint came from. */
    fingerprintFrom?: "file tag" | "stored";
    /** The matched recording MBID (only reachable via `answered`). */
    recordingMbid: string;
    artistMbid?: string;
    releaseGroupMbid?: string;
    /** The fingerprint behind the answer, when one was available. */
    fingerprint?: string;
}

/** Tag values may arrive as a string or a single-element array. */
function firstTag(value: unknown): string | null {
    if (!value) return null;
    const v = Array.isArray(value) ? value[0] : value;
    return typeof v === "string" && v.length > 0 ? v : null;
}

function toIdentification(
    result: AcoustIDResult
): Omit<TrackIdentification, "source"> {
    return {
        recordingMbid: result.recordingMbid,
        artistMbid: result.artistMbid || undefined,
        releaseGroupMbid: result.releaseGroupMbid || undefined,
    };
}

/**
 * Read the file's identity tags, the first identification step and the only
 * one that needs no network. Returns null when the
 * stored path is unusable or the file cannot be parsed; the caller then
 * proceeds as if the file had no tags.
 */
export async function readIdentityTags(
    track: IdentifiableTrack
): Promise<IdentityTags | null> {
    // The stored path is relative to the music folder; the tag reader and
    // fpcalc both need the real file. Same escape-safe resolution the
    // stream route uses -- a path that would leave the music folder is
    // not opened.
    const absolutePath = resolveTrackFilePath(track.filePath);
    if (!absolutePath) {
        logger.warn(
            `[AcoustID] Track ${track.id} path escapes the music folder: ${track.filePath}`
        );
        return null;
    }

    try {
        const metadata = await parseFile(absolutePath);
        const common = metadata.common as unknown as Record<string, unknown>;
        return {
            recordingMbid: firstTag(common.musicbrainz_recordingid),
            // Never trust an acoustid_id tag as a recording id -- it names
            // AcoustID's own cluster, a different namespace.
            fingerprint: firstTag(common.acoustid_fingerprint),
            artists: [
                ...(Array.isArray(common.artists) ? (common.artists as unknown[]) : []),
                common.artist,
            ].filter((a): a is string => typeof a === "string" && a.trim() !== ""),
            duration:
                track.duration > 0
                    ? track.duration
                    : Math.floor(metadata.format.duration || 0),
        };
    } catch (err: any) {
        logger.debug(
            `[AcoustID] Tag read failed for ${absolutePath}: ${err?.message}`
        );
        return null;
    }
}

/**
 * AcoustID for a track the tags and name search could not identify, using the
 * tagged or stored (`Track.acoustidFingerprint`) fingerprint. `permanent` means
 * no fingerprint or no client key; the stage gate normally keeps the question
 * open until a fingerprint exists.
 */
export async function identifyTrackByAcoustid(
    track: IdentifiableTrack,
    tags?: IdentityTags | null,
    stored?: { fingerprint: string } | null
): Promise<Outcome<TrackIdentification>> {
    const known = tags ?? (await readIdentityTags(track));
    if (!known) {
        // The file's tags are unreadable, but a stored fingerprint can
        // still drive the lookup — with the duration the scanner measured.
        if (stored?.fingerprint) {
            return askAcoustid(track, stored.fingerprint, track.duration, "stored_fingerprint");
        }
        acoustidTrackIdentityTotal.inc({ path: "no_fingerprint", outcome: "refused" });
        // No stored fingerprint and no readable tags: nothing to ask with.
        // A refusal, not an answer — fpcalc is never run here; the
        // fingerprint stage owns that question.
        return {
            kind: "permanent",
            error: {
                code: "NO_FINGERPRINT",
                message:
                    "No fingerprint in the tags and none stored — cannot ask AcoustID",
            },
        };
    }

    // Path 1: what the file itself already knows -- the recording id tag
    // answers with no network call at all.
    if (known.recordingMbid) {
        acoustidTrackIdentityTotal.inc({
            path: "recording_tag",
            outcome: "resolved",
        });
        return answered(
            {
                source: "file_tag",
                recordingMbid: known.recordingMbid,
                fingerprint: known.fingerprint ?? undefined,
            },
            { path: "recording_tag", source: "file tag musicbrainz_recordingid" }
        );
    }

    // Path 2: the tag's fingerprint, else the fingerprint stage's stored answer. fpcalc is never run
    // here: the stage owns that question, and one decode path keeps damaged files answered one way.
    if (known.fingerprint) {
        return askAcoustid(track, known.fingerprint, known.duration, "tag_fingerprint");
    }
    if (stored?.fingerprint) {
        return askAcoustid(track, stored.fingerprint, known.duration, "stored_fingerprint");
    }

    // No fingerprint anywhere: refuse the question rather than fake an
    // answer. The recording stage is gated on the fingerprint question
    // being settled, so this is unreachable from the engine — a guard,
    // not a wait: waiting is the gate's job, and fpcalc is never run here.
    acoustidTrackIdentityTotal.inc({ path: "no_fingerprint", outcome: "refused" });
    return {
        kind: "permanent",
        error: {
            code: "NO_FINGERPRINT",
            message:
                "No fingerprint in the tags and none stored — cannot ask AcoustID",
        },
    };
}

/** One lookup with a fingerprint in hand; `path` names where the fingerprint came from, in the metric and
 * in the answer's `fingerprintFrom`. */
async function askAcoustid(
    track: IdentifiableTrack,
    fingerprint: string,
    duration: number,
    path: "tag_fingerprint" | "stored_fingerprint"
): Promise<Outcome<TrackIdentification>> {
    const result = await acoustidService.lookup(duration, fingerprint, { title: track.title });
    if (result.kind === "answered") {
        acoustidTrackIdentityTotal.inc({ path, outcome: "resolved" });
        return answered(
            {
                source: "acoustid",
                fingerprintFrom: path === "tag_fingerprint" ? "file tag" : "stored",
                ...toIdentification(result.value),
                fingerprint,
            },
            result.evidence
        );
    }
    if (result.kind === "absent") {
        acoustidTrackIdentityTotal.inc({ path, outcome: "no_match" });
        return absent({
            ...result.evidence,
            fingerprint,
            reason:
                "asked and nothing matched; the fingerprint is still worth storing",
        });
    }
    acoustidTrackIdentityTotal.inc({ path, outcome: result.kind });
    return result;
}

/**
 * Persist the fingerprint behind an identification for intra-library
 * duplicate/version detection. A failed write throws with its real error:
 * the caller records a genuine failure on the stage record and keeps the
 * question open.
 */
export async function persistAcoustidFingerprint(
    trackId: string,
    fingerprint: string
): Promise<void> {
    await prisma.track.update({
        where: { id: trackId },
        data: { acoustidFingerprint: fingerprint },
    });
}