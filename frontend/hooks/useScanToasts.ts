import { useEffect } from "react";
import { useToast } from "@/lib/toast-context";

interface ScanResult {
    tracksAdded: number;
    tracksUpdated: number;
    tracksMissing: number;
    tracksCorrupt: number;
}

function scanSummary(r: ScanResult): string {
    const parts = [
        r.tracksAdded > 0 && `${r.tracksAdded} added`,
        r.tracksUpdated > 0 && `${r.tracksUpdated} updated`,
        r.tracksMissing > 0 && `${r.tracksMissing} missing`,
        r.tracksCorrupt > 0 && `${r.tracksCorrupt} corrupt`,
    ].filter(Boolean);
    return parts.length > 0 ? `Scan finished: ${parts.join(", ")}` : "Scan finished: no changes";
}

export function useScanToasts() {
    const { toast } = useToast();

    useEffect(() => {
        const handler = (e: Event) => {
            const { result, error } = (e as CustomEvent).detail;
            if (error) toast.error(`Scan failed: ${error}`);
            else if (result) toast.success(scanSummary(result));
        };

        window.addEventListener("scan-finished", handler);
        return () => window.removeEventListener("scan-finished", handler);
    }, [toast]);
}
