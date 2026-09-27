/**
 * Track identification helpers
 * (supersedes the earlier "AcoustID first" order).
 *
 * The identification order the worker must follow:
 *
 *   1. The file's own identity tags — `readIdentityTags` returns a
 *      `musicbrainz_recordingid` tag with no network call, and the
 *      `acoustid_fingerprint` tag for step 3 if one is present.
 *   2. The title-checked MusicBrainz name search — the caller runs it when
 *      the tags did not answer, and takes its answer before AcoustID.
 *   3. AcoustID for the remainder — `identifyTrackByAcoustid` runs only
 *      when steps 1 and 2 both failed: the tag's fingerprint or the stored
 *      `Track.acoustidFingerprint` (the fingerprint stage's answer) goes
 *      through the AcoustID lookup. This module NEVER runs fpcalc — one
 *      fingerprinter per fact; when no fingerprint exists the step is owed,
 *      not recomputed.
 *
 * An `acoustid_id` tag is NOT a recording id. It names AcoustID's own
 * fingerprint cluster (one cluster can map to several recordings), so it is
 * never returned as `recordingMbid`; a file carrying only that tag goes
 * through the fingerprint path like any other.
 *
 * Every terminal outcome is counted in kima_acoustid_track_identity_total
 * (labels path/outcome) so the resolution mix is observable per run.
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
    /** `track.duration`, or the file's own duration when that is unset. */
    duration: number;
}

export interface TrackIdentification {
    source: "file_tag" | "stored";
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
 * Read the file's identity tags — the first step, and the
 * only identification step that needs no network. Returns null when the
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
 * Ask AcoustID the recording question for a track the tags and the name
 * search could not answer. Pass the tags from
 * `readIdentityTags` when they are already known; they are re-read
 * otherwise. Pass `stored` — `{ fingerprint }` from `Track.acoustidFingerprint`
 * — to reuse the fingerprint the fingerprint stage already measured instead
 * of recomputing it with fpcalc. This function NEVER runs fpcalc: one
 * fingerprinter per fact, the fingerprint stage.
 *
 * The kinds, straight through from the lookup:
 *  - `answered` — a recording matched; the identification carries it plus
 *    the fingerprint (the caller stores the dedupe column either way).
 *  - `absent` — the question was asked and nothing matched; the
 *    fingerprint sits in the evidence so the caller still stores it.
 *  - `permanent` — nothing to ask with (no fingerprint anywhere) or no
 *    client key; the caller must not fake an answer. The recording stage
 *    is gated on the fingerprint question being SETTLED
 *    (PREREQUISITE_STAGE), so "no fingerprint anywhere" here means the
 *    gate leaked — it is the gate's job to keep the question open.
 *  - `transient`/`rateLimited` — a real call failure with its cause; the
 *    stage stays open until the retry ladder or the source pause resolves.
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
            return askAcoustid(track, stored.fingerprint, track.duration, "stored");
        }
        acoustidTrackIdentityTotal.inc({ path: "file_tag", outcome: "refused" });
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
            path: "file_tag",
            outcome: "resolved",
        });
        return answered(
            {
                source: "file_tag",
                recordingMbid: known.recordingMbid,
                fingerprint: known.fingerprint ?? undefined,
            },
            { path: "file_tag", source: "file tag musicbrainz_recordingid" }
        );
    }

    // Path 2: the tag's fingerprint, else the STORED one — the fingerprint
    // stage's answer; recomputing it would spend a second fpcalc run on a
    // number we already have, and the two decode paths disagreed about
    // damaged files.
    if (known.fingerprint) {
        return askAcoustid(track, known.fingerprint, known.duration, "file_tag");
    }
    if (stored?.fingerprint) {
        return askAcoustid(track, stored.fingerprint, known.duration, "stored");
    }

    // No fingerprint anywhere: refuse the question rather than fake an
    // answer. The recording stage is gated on the fingerprint question
    // being settled, so this is unreachable from the engine — a guard,
    // not a wait: waiting is the gate's job, and fpcalc is never run here.
    acoustidTrackIdentityTotal.inc({ path: "stored", outcome: "refused" });
    return {
        kind: "permanent",
        error: {
            code: "NO_FINGERPRINT",
            message:
                "No fingerprint in the tags and none stored — cannot ask AcoustID",
        },
    };
}

/**
 * One AcoustID lookup with a fingerprint already in hand — tagged, or the
 * fingerprint stage's stored answer. `path` is where the fingerprint came
 * from and labels the identity metric; `source` (what the recording record
 * records) keeps the distinction: a fingerprint read from the file's own
 * tags identifies as `file_tag`, the stored stage answer as `stored`.
 */
async function askAcoustid(
    track: IdentifiableTrack,
    fingerprint: string,
    duration: number,
    path: "file_tag" | "stored"
): Promise<Outcome<TrackIdentification>> {
    const result = await acoustidService.lookup(duration, fingerprint);
    if (result.kind === "answered") {
        acoustidTrackIdentityTotal.inc({ path, outcome: "resolved" });
        return answered(
            {
                source: path,
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