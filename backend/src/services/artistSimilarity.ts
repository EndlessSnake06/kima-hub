/**
 * Similar artists, discovery first: ListenBrainz by MBID, then Deezer by name when it is short. Source
 * scores run from 0.5 to 0.95 (ListenBrainz) or 0.9 (Deezer), strongest first. The library only marks
 * `inLibrary` and moves each score by at most RERANK_MAX_DELTA by how close the artists are on the
 * matching formula.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import {
    listenBrainzService,
    type SimilarArtist,
} from "./listenBrainz";
import { deezerService } from "./deezer";
import { artistMatch } from "./matching/formula";
import { artistProfiles } from "./matching/rank";
import { loadMatchingState } from "./matching/state";

export type { SimilarArtist };

/**
 * SimilarArtist plus the in-library flag. Identical to SimilarArtist apart
 * from the optional `inLibrary` field, so every existing consumer that
 * types against SimilarArtist keeps compiling.
 */
export interface SimilarArtistWithLibrary extends SimilarArtist {
    /** True when the artist has rows in this library (MBID-then-name lookup). */
    inLibrary?: boolean;
}

/** 7 days: similarity data changes slowly. */
const CACHE_TTL = 604800;

/**
 * Maximum ± adjustment the library re-rank may apply to any match score.
 * Small on purpose: it leans results toward artists we actually own without
 * letting local audio analysis override global taste data.
 */
const RERANK_MAX_DELTA = 0.1;

/**
 * Similar artists for an MBID ("" when unknown). ListenBrainz and Deezer run
 * concurrently and ListenBrainz wins when it fills the request; both empty
 * means an empty answer. Never throws: for callers that show what there is.
 */
export async function getSimilarArtists(
    artistMbid: string,
    artistName: string,
    limit = 30,
    opts: { interactive?: boolean } = {}
): Promise<SimilarArtistWithLibrary[]> {
    return (await findSimilarArtists(artistMbid, artistName, limit, opts)).artists;
}

/**
 * The same, saying whether a source that was asked failed to answer. `failed` with
 * artists means a partial list; enrichment keeps what it stored and asks again.
 */
export async function findSimilarArtists(
    artistMbid: string,
    artistName: string,
    limit = 30,
    opts: { interactive?: boolean } = {}
): Promise<{ artists: SimilarArtistWithLibrary[]; failed: boolean }> {
    const cacheKey = `artist-similar:${artistMbid || artistName}:${limit}`;
    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached) as SimilarArtistWithLibrary[];
            if (parsed.length > 0) return { artists: parsed, failed: false };
        }
    } catch (err) {
        logger.warn("[ArtistSimilarity] Redis read error:", err);
    }

    const hasMbid = typeof artistMbid === "string" && artistMbid.length > 0;

    // --- Tier 1 (ListenBrainz) + Tier 2 (Deezer), concurrently ---
    let failed = false;
    const [lb, dz] = await Promise.all([
        hasMbid
            ? listenBrainzService
                  .getSimilarArtists(artistMbid, artistName, limit, opts)
                  .catch(() => {
                      failed = true;
                      return [] as SimilarArtist[];
                  })
            : Promise.resolve([] as SimilarArtist[]),
        deezerService
            .getRelatedArtists(artistName, limit)
            .catch(() => {
                failed = true;
                return [] as SimilarArtist[];
            }),
    ]);

    let results: SimilarArtist[];
    if (lb.length >= limit) {
        // Global data filled the request — keep ListenBrainz alone.
        results = lb.slice(0, limit);
    } else if (lb.length > 0 || dz.length > 0) {
        // LB short or empty: Deezer fills the rest; dedupe by name so the
        // same artist from both sources appears once (LB entries win).
        results = dedupeByName([...lb, ...dz]).slice(0, limit);
    } else {
        // Neither remote source knows this artist; the library does not substitute its own.
        return { artists: [], failed };
    }

    // Re-rank against the library, then cache and return.
    const reranked = await rerankWithLibrary(
        results,
        artistMbid,
        artistName
    );
    if (reranked.length > 0 && !failed) {
        await store(cacheKey, reranked);
    }
    return { artists: reranked, failed };
}

/**
 * Mark `inLibrary` (by MBID, then name) and nudge owned artists' scores by how
 * close they are to the seed on the matching formula, at most RERANK_MAX_DELTA,
 * then re-sort. On a DB failure the input passes through with inLibrary false.
 */
async function rerankWithLibrary(
    results: SimilarArtist[],
    seedMbid: string,
    seedName: string
): Promise<SimilarArtistWithLibrary[]> {
    if (results.length === 0) return [];

    try {
        // 1. Resolve each result to a local Artist row: MBID first, then
        // name for whatever the MBID lookup missed (Deezer results carry no
        // MBID, and LB MBIDs may not exist in our Artist table).
        const mbids = [
            ...new Set(
                results
                    .map((r) => r.mbid)
                    .filter((m): m is string => typeof m === "string" && m.length > 0)
            ),
        ];
        const rowByMbid = new Map<string, string>(); // mbid -> Artist row id
        if (mbids.length > 0) {
            const rows = await prisma.artist.findMany({
                where: { mbid: { in: mbids } },
                select: { id: true, mbid: true },
            });
            for (const r of rows) if (r.mbid) rowByMbid.set(r.mbid, r.id);
        }
        const missedNames = [
            ...new Set(
                results
                    .filter((r) => !r.mbid || !rowByMbid.has(r.mbid))
                    .map((r) => r.name)
            ),
        ];
        const rowByName = new Map<string, string>(); // name -> Artist row id
        if (missedNames.length > 0) {
            const rows = await prisma.artist.findMany({
                where: { name: { in: missedNames } },
                select: { id: true, name: true },
            });
            for (const r of rows) rowByName.set(r.name, r.id);
        }
        const resolveRow = (r: SimilarArtist): string | undefined =>
            (r.mbid ? rowByMbid.get(r.mbid) : undefined) ??
            rowByName.get(r.name);

        // 2. The seed's own row, which closeness is measured from.
        let seedRowId: string | undefined;
        if (seedMbid) {
            seedRowId =
                (await prisma.artist.findUnique({
                    where: { mbid: seedMbid },
                    select: { id: true },
                }))?.id ?? undefined;
        } else if (seedName) {
            seedRowId =
                (await prisma.artist.findFirst({
                    where: { name: seedName },
                    select: { id: true },
                }))?.id ?? undefined;
        }

        // 3. The seed's and each owned result's tracks, averaged, in one query.
        const ids = new Set<string>();
        if (seedRowId) ids.add(seedRowId);
        for (const r of results) {
            const id = resolveRow(r);
            if (id) ids.add(id);
        }
        const state = await loadMatchingState();
        const profiles =
            state && seedRowId ? await artistProfiles(state, [...ids]) : new Map();
        const seedProfile = seedRowId ? profiles.get(seedRowId) : undefined;

        // 4. Adjusted scores + flags. Closeness 1 → +0.1; closeness 0 or
        // less → −0.1. An artist without matching data is not adjusted.
        const out: SimilarArtistWithLibrary[] = results.map((r) => {
            const rowId = resolveRow(r);
            const inLibrary = !!rowId;
            let match = r.match;
            const resultProfile = rowId ? profiles.get(rowId) : undefined;
            const closeness =
                state && seedProfile && resultProfile
                    ? artistMatch(seedProfile, resultProfile, state.genres, state.genreWeight ** 2)
                    : null;
            if (closeness !== null) {
                const distance = 1 - closeness;
                const delta =
                    RERANK_MAX_DELTA *
                    (1 - 2 * Math.min(Math.max(distance, 0), 1));
                match = Math.min(1, Math.max(0, r.match + delta));
            }
            return { ...r, match, inLibrary };
        });

        // Re-rank: sort by the adjusted score. Array#sort is stable, so
        // untouched entries keep their source order on ties.
        out.sort((a, b) => b.match - a.match);
        return out;
    } catch (err) {
        logger.warn(
            `[ArtistSimilarity] library re-rank failed for ${seedName}:`,
            err
        );
        return results.map((r) => ({ ...r, inLibrary: false }));
    }
}

async function store(key: string, value: SimilarArtist[]): Promise<void> {
    try {
        await redisClient.setex(key, CACHE_TTL, JSON.stringify(value));
    } catch (err) {
        logger.warn("[ArtistSimilarity] Redis write error:", err);
    }
}

/**
 * Dedupe by normalized name — the merge key across sources. Deezer results
 * carry no MBID and LB results may carry MBIDs the other source doesn't
 * know about, so name is the only key that collapses "same artist, two
 * sources" into one entry. First occurrence wins (LB before Deezer).
 */
function dedupeByName(list: SimilarArtist[]): SimilarArtist[] {
    const seen = new Set<string>();
    const out: SimilarArtist[] = [];
    for (const item of list) {
        const key = item.name.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

/** A similar artist as a search result. */
interface SimilarArtistEntry {
    type: "music";
    id: string;
    name: string;
    listeners: number;
    url: string;
    image: string | null;
    mbid?: string;
    bio: string | null;
    tags: string[];
}

/**
 * Search-result entries for similar artists. The first three get a bio,
 * artwork and genres; the rest get artwork only.
 */
export async function enrichSimilarArtists(similar: SimilarArtist[], limit = 6): Promise<SimilarArtistEntry[]> {
    const { findArtistArtwork } = await import("./artwork");
    const { wikidataService } = await import("./wikidata");
    const { isMbid } = await import("./artistIdentity");

    const capped = similar.slice(0, limit);
    const enrichCount = Math.min(3, capped.length);

    const build = async (s: SimilarArtist, enrich: boolean): Promise<SimilarArtistEntry> => {
        const base = {
            type: "music" as const,
            id: s.mbid || s.name,
            name: s.name,
            listeners: 0, // neither source publishes listener counts
            url: s.url,
            image: null as string | null,
            mbid: s.mbid,
            bio: null as string | null,
            tags: [] as string[], // Wikidata serves no tags
        };
        const validMbid = s.mbid && isMbid(s.mbid) ? s.mbid : undefined;

        if (!enrich) {
            base.image =
                (await findArtistArtwork({
                    name: s.name,
                    mbid: validMbid,
                }))?.url ?? null;
            return base;
        }

        const [wd, found] = await Promise.all([
            validMbid
                ? wikidataService.getArtistInfo(s.name, validMbid)
                : Promise.resolve(null),
            findArtistArtwork({ name: s.name, mbid: validMbid }),
        ]);
        base.image = found?.url ?? null;
        base.bio = wd?.summary || null;
        return base;
    };

    const [enriched, fast] = await Promise.all([
        Promise.all(capped.slice(0, enrichCount).map((s) => build(s, true))),
        Promise.all(capped.slice(enrichCount).map((s) => build(s, false))),
    ]);
    return [...enriched, ...fast];
}
