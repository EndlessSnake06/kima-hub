/**
 * Artist name correction via MusicBrainz for Lidarr and Soulseek acquisition:
 * { corrected, canonicalName, mbid } | null. "of mice" must resolve to "Of Mice
 * & Men" and "blink" to "blink-182"; suffixes such as "(feat. Y)" or "[Live]"
 * are removed before searching.
 */

import * as fuzz from "fuzzball";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { musicBrainzService } from "./musicbrainz";
import { failureCause } from "../utils/outcome";
import { normalizeArtistName } from "../utils/artistNormalization";

export interface ArtistCorrection {
    corrected: boolean;
    canonicalName: string;
    mbid?: string;
}

/** 30 days — corrections are near-permanent, same as the old path. */
const CORRECTION_TTL = 2592000;

/**
 * Strip collaboration/edition noise from an artist name before searching.
 * "Gun N' Roses (feat. Codex)" → "Gun N' Roses"
 * "The Beatles [2009 Remaster]" → "The Beatles"
 */
function stripArtistSuffixes(name: string): string {
    let cleaned = name
        .replace(
            /\s*[\[(](?:feat|ft|featuring|with)\.?\s+[^\])]*[\])]/gi,
            ""
        )
        .replace(
            /\s*[\[(](?:\d{4} )?(?:remaster|remastered|deluxe|expanded|anniversary|bonus|special|mono|stereo)(?:\s+edition)?[^\])]*[\])]/gi,
            ""
        )
        .replace(/\s*-\s*(?:\d{4} )?(?:remaster|remastered|single|live|acoustic)(?:\s+version)?$/i, "")
        .trim();
    if (!cleaned || cleaned.length < 2) cleaned = name.trim();
    return cleaned;
}

/**
 * Resolve a possibly-messy artist name to its canonical form.
 * Returns null, meaning "keep the original name", when nothing confident was found.
 */
export async function getArtistCorrection(
    artistName: string
): Promise<ArtistCorrection | null> {
    const cacheKey = `mb:correction:${artistName.toLowerCase().trim()}`;

    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            return cached === "null" ? null : (JSON.parse(cached) as ArtistCorrection);
        }
    } catch (err) {
        logger.warn("Redis get error:", err);
    }

    const cleaned = stripArtistSuffixes(artistName);

    try {
        const found = await musicBrainzService.searchArtist(cleaned, 5);

        if (
            found.kind === "rateLimited" ||
            found.kind === "transient" ||
            found.kind === "permanent"
        ) {
            logger.warn(
                `MB correction ${found.kind} for ${artistName}: ${failureCause(found)}`
            );
            // Do NOT cache failures — a timeout must not freeze a
            // correction (or its absence) for 30 days.
            return null;
        }
        const candidates = found.kind === "answered" ? found.value : [];

        // Score candidates with token-set fuzzy match against the cleaned
        // query; require a confident match (>= 90) before correcting.
        interface Scored {
            name: string;
            mbid: string;
            score: number;
        }
        const scored: Scored[] = candidates
            .map((a) => ({
                name: a.name,
                mbid: a.id,
                score: fuzzyScore(cleaned, a.name),
            }))
            .filter((c) => c.score >= 90)
            .sort((a, b) => b.score - a.score);

        const best = scored[0];
        if (!best) {
            await redisClient.setex(cacheKey, CORRECTION_TTL, "null");
            return null;
        }

        const result: ArtistCorrection = {
            corrected:
                normalizeArtistName(best.name) !== normalizeArtistName(artistName),
            canonicalName: best.name,
            mbid: best.mbid || undefined,
        };

        await redisClient.setex(cacheKey, CORRECTION_TTL, JSON.stringify(result));
        return result;
    } catch (error: any) {
        logger.warn(
            `MB correction error for ${artistName}: ${error?.message || error}`
        );
        // Do NOT cache failures — a timeout must not freeze a correction
        // (or its absence) for 30 days.
        return null;
    }
}

function fuzzyScore(a: string, b: string): number {
    return fuzz.token_set_ratio(
        normalizeArtistName(a),
        normalizeArtistName(b)
    );
}
