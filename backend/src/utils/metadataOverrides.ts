/**
 * Metadata Override Utilities
 *
 * Helper functions for working with user metadata overrides.
 * Implements the pattern: display = userOverride ?? canonical
 */

/**
 * Get merged genres (user + canonical) for functional use in mixes/discovery
 * User-added genres take precedence and are merged with canonical genres
 *
 * CRITICAL: This is used for mix generation, discovery, and genre filtering.
 * User genres always take precedence.
 */
export function getMergedGenres(entity: {
    genres?: unknown;
    userGenres?: unknown;
}): string[] {
    const canonical = Array.isArray(entity.genres)
        ? entity.genres
        : typeof entity.genres === "string"
        ? JSON.parse(entity.genres)
        : [];

    const userAdded = Array.isArray(entity.userGenres)
        ? entity.userGenres
        : typeof entity.userGenres === "string"
        ? JSON.parse(entity.userGenres)
        : [];

    // Merge and deduplicate (user genres first for priority)
    const merged = [...new Set([...userAdded, ...canonical])];
    return merged;
}

/**
 * Get display summary for an artist
 * User override takes precedence over canonical summary
 */
export function getArtistDisplaySummary(artist: {
    userSummary?: string | null;
    summary?: string | null;
}): string | null {
    return artist.userSummary ?? artist.summary ?? null;
}
