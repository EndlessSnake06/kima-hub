/**
 * The one place that goes looking for a picture.
 *
 * There used to be four. `imageProviderService` walked Deezer, the Cover Art
 * Archive and Fanart in order. `coverArtService` asked only the archive.
 * `deezerService` asked only Deezer. And two routes built an archive address by
 * hand -- `coverartarchive.org/release-group/<mbid>/front-500` -- and sent it
 * out without ever asking whether that picture existed.
 *
 * Fifteen call sites wanted artwork. Twelve of them used a door that asks one
 * provider and gives up. That is why so much of the app showed placeholders:
 * not because nobody had the artwork, but because nobody asked more than once.
 *
 * Measured on 39 real albums:
 *
 *     the guessed archive address loads      21 / 39
 *     Deezer has it                          31 / 39
 *     asking every source in turn            34 / 39
 *
 * So: one function per kind of thing, one ordered list of sources, one loop
 * through them, one cache in front. Adding a provider means adding a line to a
 * list. A placeholder now means every source was asked and none had it.
 */

import crypto from "crypto";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { validateUrlForFetch } from "../utils/ssrf";
import { coverArtService } from "./coverArt";
import { deezerService } from "./deezer";
import { fanartService } from "./fanart";

/** Artwork for a released record does not change. */
const FOUND_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Short, because "nobody has it" is a temporary state of the world. Art gets
 * uploaded; a record out next month usually gets a cover eventually.
 */
const NONE_TTL_SECONDS = 24 * 60 * 60;

const NONE = "NONE";
const USER_AGENT = "Kima/1.0 (+https://github.com/chevron7locked/kima)";

/**
 * Is this a real MusicBrainz id, or one this app invented?
 *
 * The scanner mints a `temp-<timestamp>-<random>` id for any album it cannot
 * match to MusicBrainz, and 436 of the 949 albums in a real library carry one.
 * Sources keyed on the id -- the Cover Art Archive, Fanart -- can do nothing
 * with a placeholder, but Deezer searches by artist and title and never needed
 * an id at all. So a placeholder means "skip the id-keyed sources", NOT "give
 * up", which is what several callers used to do: they returned before asking
 * anyone, and 46% of the library could never get a cover from anywhere.
 */
export function isRealMbid(id: string | null | undefined): boolean {
    return Boolean(id) && !id!.startsWith("temp-");
}

export interface AlbumArtworkQuery {
    /** MusicBrainz release-group id, when the caller has one. */
    rgMbid?: string | null;
    artistName: string;
    albumTitle: string;
    /**
     * An address the caller was handed by something else -- Lidarr ships one
     * with its calendar. Tried last, and only after checking that it loads.
     */
    candidateUrl?: string | null;
}

export interface ArtistArtworkQuery {
    name: string;
    mbid?: string | null;
    candidateUrl?: string | null;
}

export interface ArtworkResult {
    url: string;
    source: string;
}

interface Source<Q> {
    name: string;
    find: (query: Q) => Promise<string | null>;
}

/* ── the sources ─────────────────────────────────────────────────────────── */

/**
 * Ordered deliberately. Fanart has the best artist thumbnails but needs an
 * MBID and an API key, so it self-skips when either is missing. Deezer is the
 * most likely to have any given record and the fastest to answer. The Cover Art
 * Archive is authoritative but a slow public mirror with big gaps. Last.fm goes
 * last because most of what it returns is the grey star.
 */
const ALBUM_SOURCES: Source<AlbumArtworkQuery>[] = [
    {
        name: "deezer",
        find: (q) => deezerService.getAlbumCover(q.artistName, q.albumTitle),
    },
    {
        name: "coverartarchive",
        // Through coverArtService, which caches a hit for thirty days, a miss
        // for seven, and puts the call through the rate limiter. This lookup
        // used to be duplicated elsewhere with none of that.
        find: (q) =>
            isRealMbid(q.rgMbid) ? coverArtService.getCoverArt(q.rgMbid!) : Promise.resolve(null),
    },
    {
        name: "fanart",
        find: (q) =>
            isRealMbid(q.rgMbid) ? fanartService.getAlbumCover(q.rgMbid!) : Promise.resolve(null),
    },
];

const ARTIST_SOURCES: Source<ArtistArtworkQuery>[] = [
    {
        name: "fanart",
        find: (q) =>
            isRealMbid(q.mbid) ? fanartService.getArtistImage(q.mbid!) : Promise.resolve(null),
    },
    {
        name: "deezer",
        find: (q) => deezerService.getArtistImage(q.name),
    },
    {
        name: "lastfm",
        find: async (q) => {
            const { lastFmService } = await import("./lastfm");
            const info = await lastFmService.getArtistInfo(
                q.name,
                isRealMbid(q.mbid) ? q.mbid! : undefined,
            );
            const images = Array.isArray(info?.image)
                ? info.image
                : info?.image
                  ? [info.image]
                  : [];
            // getBestImage already returns null for the grey star Last.fm
            // serves when it has no picture. Five call sites used to filter
            // that hash again by hand on top of it.
            return lastFmService.getBestImage(images);
        },
    },
];

/* ── the loop ────────────────────────────────────────────────────────────── */

/**
 * Walk the sources in order and take the first real answer.
 *
 * A source that throws is logged and skipped, never fatal: one provider being
 * down must not cost us the answer another one has.
 */
async function firstAnswer<Q>(
    sources: Source<Q>[],
    query: Q,
    label: string,
): Promise<{ found: ArtworkResult | null; everyoneAnswered: boolean }> {
    let everyoneAnswered = true;

    for (const source of sources) {
        try {
            const url = await source.find(query);
            if (url) {
                logger.debug(`[Artwork] ${label}: found via ${source.name}`);
                return { found: { url, source: source.name }, everyoneAnswered: true };
            }
        } catch (error) {
            // A source that throws has not told us the picture is missing; it
            // has told us nothing. Carry on to the next one, but remember that
            // this run is not a complete answer -- see the caller, which
            // refuses to write "nobody has it" on the strength of a run where
            // somebody failed to speak.
            everyoneAnswered = false;
            logger.debug(
                `[Artwork] ${label}: ${source.name} failed -- ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
    return { found: null, everyoneAnswered };
}

/**
 * Is there really a picture at this address?
 *
 * Only ever asked about an address a caller was handed, never one a source
 * returned. A timeout or a server error is not an answer -- treating it as one
 * would drop a good cover over a blip -- so only a clear "not found" counts.
 */
async function addressLoads(url: string): Promise<boolean> {
    if (await validateUrlForFetch(url)) return false;
    try {
        const response = await fetch(url, {
            method: "HEAD",
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(2500),
            redirect: "follow",
        });
        return !(response.status === 404 || response.status === 410);
    } catch {
        return true;
    }
}

/* ── the cache in front ──────────────────────────────────────────────────── */

function keyFor(kind: string, identity: string): string {
    return `artwork:${kind}:${crypto.createHash("md5").update(identity).digest("hex")}`;
}

const albumKey = (q: AlbumArtworkQuery) =>
    keyFor(
        "album",
        isRealMbid(q.rgMbid)
            ? `rg:${q.rgMbid}`
            : `nt:${q.artistName.toLowerCase()}|${q.albumTitle.toLowerCase()}`,
    );

const artistKey = (q: ArtistArtworkQuery) =>
    keyFor("artist", isRealMbid(q.mbid) ? `mb:${q.mbid}` : `n:${q.name.toLowerCase()}`);

/** `undefined` means we have not asked yet; `null` means we asked and nobody had it. */
async function remembered(key: string): Promise<string | null | undefined> {
    try {
        const hit = await redisClient.get(key);
        if (hit === NONE) return null;
        if (hit) return hit;
    } catch {
        // A cache that is down means we do not know, not that there is nothing.
    }
    return undefined;
}

async function remember(key: string, url: string | null): Promise<void> {
    try {
        await redisClient.setex(key, url ? FOUND_TTL_SECONDS : NONE_TTL_SECONDS, url ?? NONE);
    } catch {
        // Losing the answer costs a repeat lookup, nothing more.
    }
}

/**
 * One lookup per record at a time, however many people are asking.
 *
 * The cache stops the SECOND request for an album, never the first N that
 * arrive together. A page showing thirty covers, opened by five people at once,
 * was thirty lookups five times over -- 150 calls to three public APIs for
 * thirty pictures, all of which would land on the same answers. Callers that
 * arrive while a lookup is already running now wait on that one instead of
 * starting their own.
 *
 * Deliberately in-process, not in Redis: this collapses the burst that a single
 * page load creates, which is the whole problem, and it does so with no lock to
 * expire, no lock to leak, and nothing to clean up if the process dies.
 */
const inFlight = new Map<string, Promise<ArtworkResult | null>>();

function once(
    key: string,
    work: () => Promise<ArtworkResult | null>,
): Promise<ArtworkResult | null> {
    const already = inFlight.get(key);
    if (already) return already;

    const running = work().finally(() => inFlight.delete(key));
    inFlight.set(key, running);
    return running;
}

/* ── the door ────────────────────────────────────────────────────────────── */

/**
 * Find a cover for an album, from whichever source has one.
 *
 * Every caller that wants album artwork goes through here, whether the album is
 * in the library or not. Returns null only when every source has been asked.
 */
export async function findAlbumArtwork(
    query: AlbumArtworkQuery,
): Promise<ArtworkResult | null> {
    if (!query.artistName || !query.albumTitle) return null;

    const key = albumKey(query);
    const cached = await remembered(key);
    if (cached !== undefined) {
        return cached ? { url: cached, source: "cache" } : null;
    }

    return once(key, async () => {
        const label = `${query.artistName} - ${query.albumTitle}`;
        const { found: fromSources, everyoneAnswered } = await firstAnswer(
            ALBUM_SOURCES,
            query,
            label,
        );

        let found = fromSources;
        if (!found && query.candidateUrl && (await addressLoads(query.candidateUrl))) {
            found = { url: query.candidateUrl, source: "given" };
        }

        // Only write down "nobody has it" when everybody actually said so. A
        // run where a provider was down or rate-limiting is not evidence of
        // absence, and recording it as one would blank that album for a day
        // over a blip. A found picture is always worth remembering.
        if (found || everyoneAnswered) {
            await remember(key, found?.url ?? null);
        }
        return found;
    });
}

/**
 * Find an image for an artist, from whichever source has one.
 *
 * Nine call sites used to ask Deezer alone and stop there.
 */
export async function findArtistArtwork(
    query: ArtistArtworkQuery,
): Promise<ArtworkResult | null> {
    if (!query.name) return null;

    const key = artistKey(query);
    const cached = await remembered(key);
    if (cached !== undefined) {
        return cached ? { url: cached, source: "cache" } : null;
    }

    return once(key, async () => {
        const { found: fromSources, everyoneAnswered } = await firstAnswer(
            ARTIST_SOURCES,
            query,
            query.name,
        );

        let found = fromSources;
        if (!found && query.candidateUrl && (await addressLoads(query.candidateUrl))) {
            found = { url: query.candidateUrl, source: "given" };
        }

        // Same rule as albums: absence is only recorded when every source agreed.
        if (found || everyoneAnswered) {
            await remember(key, found?.url ?? null);
        }
        return found;
    });
}

/* ── a page's worth at a time ────────────────────────────────────────────── */

/** Polite to three public APIs, fast enough for a page of covers. */
const CONCURRENCY = 6;

/** How long a page will wait for covers it does not already know. */
const DEFAULT_BUDGET_MS = 3000;

/**
 * Put artwork on a list of albums, spending at most `budgetMs` of the caller's
 * time on the ones not already known.
 *
 * `read` says how to get the identifying details off one of the caller's items,
 * `write` says where to put the answer back. Generic because the callers carry
 * different shapes and none of them should have to reshape to use this.
 *
 * Anything still unanswered when the budget runs out keeps whatever the caller
 * already had and is finished in the background, so a slow provider delays
 * nobody and the next view is right.
 */
export async function withAlbumArtwork<T>(
    items: T[],
    read: (item: T) => AlbumArtworkQuery,
    write: (item: T, coverUrl: string | null) => T,
    options: { budgetMs?: number } = {},
): Promise<T[]> {
    if (items.length === 0) return items;

    const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    const queries = items.map(read);
    const answers = new Map<string, string | null>();

    // One lookup per distinct record, however many times it is listed.
    const distinct = new Map<string, AlbumArtworkQuery>();
    for (const q of queries) {
        if (q.artistName && q.albumTitle) distinct.set(albumKey(q), q);
    }

    const unresolved: [string, AlbumArtworkQuery][] = [];
    await Promise.all(
        [...distinct].map(async ([key, q]) => {
            const hit = await remembered(key);
            if (hit === undefined) unresolved.push([key, q]);
            else answers.set(key, hit);
        }),
    );

    // Until we know better, send nothing.
    //
    // The obvious alternative -- keep whatever the caller already had -- is
    // worse than it looks. The only caller that carries a candidate is the
    // Release Radar, and its candidate is the unchecked Cover Art Archive
    // address Lidarr ships, which is the exact thing this module exists to stop
    // sending. So the one moment the budget fires would be the one moment the
    // original bug came back: a browser 404 on a guessed address, invisible
    // from this server.
    //
    // A page drawing its placeholder is honest and corrects itself on the next
    // view, because the lookups that ran out of time finish in the background.
    for (const [key] of unresolved) answers.set(key, null);

    const deadline = Date.now() + budgetMs;
    const queue = [...unresolved];
    const leftover: AlbumArtworkQuery[] = [];

    const worker = async () => {
        for (;;) {
            const next = queue.shift();
            if (!next) return;
            const [key, q] = next;
            if (Date.now() >= deadline) {
                leftover.push(q);
                continue;
            }
            const found = await findAlbumArtwork(q);
            answers.set(key, found?.url ?? null);
        }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

    if (leftover.length > 0) {
        logger.debug(
            `[Artwork] ${leftover.length} covers ran past the ${budgetMs}ms budget; finishing in the background`,
        );
        void finishLater(leftover);
    }

    return items.map((item, i) => {
        const q = queries[i];
        if (!q.artistName || !q.albumTitle) return write(item, null);
        return write(item, answers.get(albumKey(q)) ?? null);
    });
}

/** Answer the stragglers after the response has gone, so the next view is right. */
async function finishLater(pending: AlbumArtworkQuery[]): Promise<void> {
    const queue = [...pending];
    const worker = async () => {
        for (;;) {
            const q = queue.shift();
            if (!q) return;
            try {
                await findAlbumArtwork(q);
            } catch (error) {
                logger.debug(`[Artwork] Background lookup failed: ${String(error)}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}
