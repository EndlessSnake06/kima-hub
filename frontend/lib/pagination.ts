/**
 * Pagination primitives shared by every paged surface.
 *
 * The collection page reads `total` from the query response, and a query that
 * fails on its first load has no data — so `total` can be missing even when
 * the list demonstrably has many pages. `latchTotal` keeps the last number we
 * actually saw so the pager can never vanish on a transient failure, while a
 * genuine zero (a real empty list) still wins.
 */
export function parsePageParam(raw: string | null): number {
    const n = parseInt(raw ?? "1", 10);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function latchTotal(latched: number, fresh: number | null | undefined): number {
    return fresh ?? latched;
}
