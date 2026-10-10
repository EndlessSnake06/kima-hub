const MAX_LIMIT = 10000;

/** A page size from a query value: `fallback` when absent or not a number, never above 10000. */
export function parseLimit(raw: unknown, fallback: number): number {
  return Math.min(parseInt(raw as string, 10) || fallback, MAX_LIMIT);
}
