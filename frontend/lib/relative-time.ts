/**
 * "Just now" / "12m ago" / "3h ago", then the local date. One clock-
 * relative formatter for the activity surfaces; the tabs used to carry
 * private copies with slightly different wording for the same fact.
 */
export function timeAgo(dateStr: string): string {
    const date = new Date(dateStr);
    const diff = Date.now() - date.getTime();

    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
}
