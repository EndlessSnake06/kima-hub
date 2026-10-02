/**
 * Data readiness gate for the dogfood walkthrough. It fails, with what is
 * missing and how to supply it, instead of letting the suite skip to green.
 */
import { APIRequestContext, expect } from "@playwright/test";

export interface LibraryFacts {
    albums: number;
    artists: number;
    tracks: number;
    playlists: number;
    /** Tracks carrying analyzer output (bpm/key/energy) -- proves the pipeline ran. */
    tracksWithAudioFeatures: number;
    /** Tracks with a CLAP embedding, which is what the vibe map is built from. */
    embeddedTracks: number;
    podcasts: number;
    audiobooks: number;
}

/** What the walkthrough needs before it is worth running at all. */
const MINIMUMS = {
    albums: 2,
    artists: 2,
    tracks: 10,
} as const;

async function getJson<T>(
    api: APIRequestContext,
    url: string,
    token: string,
): Promise<T | null> {
    const res = await api.get(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok()) return null;
    return (await res.json()) as T;
}

/**
 * Read what is actually in this instance.
 *
 * Everything is best-effort except the three counts the walkthrough cannot proceed without.
 * A missing podcast feed means the podcast journey is skipped with a reason recorded; a
 * missing library means the run stops.
 */
export async function readLibraryFacts(
    api: APIRequestContext,
    token: string,
): Promise<LibraryFacts> {
    const [albums, artists, tracks, playlists, podcasts, audiobooks] = await Promise.all([
        getJson<{ total: number }>(api, "/api/library/albums?limit=1", token),
        getJson<{ total: number }>(api, "/api/library/artists?limit=1", token),
        getJson<{ total: number }>(api, "/api/library/tracks?limit=1", token),
        getJson<unknown>(api, "/api/playlists", token),
        getJson<unknown>(api, "/api/podcasts", token),
        getJson<unknown>(api, "/api/audiobooks", token),
    ]);

    // A sample large enough to tell "the analyzer ran" from "the analyzer ran on one track".
    const sample = await getJson<{
        tracks: Array<{ audioFeatures?: { bpm?: number | null } | null }>;
    }>(api, "/api/library/tracks?limit=50", token);

    const withFeatures =
        sample?.tracks?.filter((t) => t.audioFeatures && t.audioFeatures.bpm != null).length ?? 0;

    // Embeddings are counted from enrichment progress, not the vibe map: a broken
    // map would otherwise read as "no embeddings" and skip the journey that should fail.
    const progress = await getJson<{ clapEmbeddings?: { completed?: number } }>(
        api,
        "/api/enrichment/progress",
        token,
    );

    const countOf = (v: unknown): number => {
        if (Array.isArray(v)) return v.length;
        if (v && typeof v === "object") {
            for (const key of ["total", "count"]) {
                const n = (v as Record<string, unknown>)[key];
                if (typeof n === "number") return n;
            }
            for (const val of Object.values(v as Record<string, unknown>)) {
                if (Array.isArray(val)) return val.length;
            }
        }
        return 0;
    };

    return {
        albums: albums?.total ?? 0,
        artists: artists?.total ?? 0,
        tracks: tracks?.total ?? 0,
        playlists: countOf(playlists),
        tracksWithAudioFeatures: withFeatures,
        embeddedTracks: progress?.clapEmbeddings?.completed ?? 0,
        podcasts: countOf(podcasts),
        audiobooks: countOf(audiobooks),
    };
}

/**
 * Stop the run if this instance cannot support a meaningful walkthrough.
 *
 * Deliberately hard. The point of a pre-deployment gate is to be the thing that says no.
 */
export function assertReady(facts: LibraryFacts, baseUrl: string): void {
    const missing: string[] = [];
    if (facts.albums < MINIMUMS.albums) {
        missing.push(`albums: found ${facts.albums}, need at least ${MINIMUMS.albums}`);
    }
    if (facts.artists < MINIMUMS.artists) {
        missing.push(`artists: found ${facts.artists}, need at least ${MINIMUMS.artists}`);
    }
    if (facts.tracks < MINIMUMS.tracks) {
        missing.push(`tracks: found ${facts.tracks}, need at least ${MINIMUMS.tracks}`);
    }

    expect(
        missing,
        `The instance at ${baseUrl} does not hold enough music to test this build.\n\n` +
            missing.map((m) => `  - ${m}`).join("\n") +
            `\n\nThis is a failure, not a skip: a walkthrough that quietly tests nothing is\n` +
            `worse than no walkthrough, because it reports the same green as a real pass.\n` +
            `Point KIMA_UI_BASE_URL at an instance with a scanned library, or scan one here.`,
    ).toHaveLength(0);
}

/**
 * Which optional journeys this instance can support.
 *
 * These are recorded rather than asserted. A test stack with no podcast feeds is a normal
 * state, and the report says so out loud so nobody mistakes an unexercised journey for a
 * passing one.
 */
export function availableJourneys(facts: LibraryFacts): {
    /** Whether the data-collection journey has enough material to be meaningful. */
    vibe: boolean;
    /** Whether the audiobook journey can run (needs audiobooks on this instance). */
    audiobooks: boolean;
    reasons: string[];
} {
    const reasons: string[] = [];

    // The collect journey rebuilds embeddings itself, so it does not need any to exist
    // beforehand -- it needs a library big enough for the timing to mean something. A
    // handful of tracks would make throughput noise rather than signal.
    const vibe = facts.tracks >= 10;
    if (!vibe) {
        reasons.push(
            `data-collection journey not run: ${facts.tracks} tracks is too few to say ` +
                `anything about pipeline throughput (needs 10+)`,
        );
    }

    // Podcasts are created by journey 5b (subscribe), so the preflight count
    // is always zero. The journey runs regardless and the deeper management
    // journey (5c) exercises the subscription lifecycle.

    const audiobooks = facts.audiobooks > 0;
    if (!audiobooks) reasons.push("audiobook journey not run: no audiobooks on this instance");

    if (facts.tracksWithAudioFeatures === 0) {
        reasons.push(
            "no analyzer output found in a 50-track sample: bpm/key/energy are absent, so " +
                "anything downstream of audio analysis is untested",
        );
    }

    return { vibe, audiobooks, reasons };
}
