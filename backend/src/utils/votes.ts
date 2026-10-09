/** The names of the `n` entries with the most votes (MusicBrainz genres and tags). */
export function topVoted(entries: Array<{ name: string; count: number }>, n: number): string[] {
    return [...entries].sort((a, b) => b.count - a.count).slice(0, n).map((e) => e.name);
}
