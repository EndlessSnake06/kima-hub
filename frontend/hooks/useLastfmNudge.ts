/**
 * Hook that polls the Last.fm nudge status and exposes the banner state.
 *
 * Kept in a separate hook so multiple surfaces (the banner, the notification
 * bell badge) can share the same flag without duplicating the fetch.
 */
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

interface UseLastfmNudgeOptions {
    /** Called when the user dismisses the nudge. */
    onDismiss?: () => void;
}

export function useLastfmNudge({ onDismiss }: UseLastfmNudgeOptions = {}) {
    const { isAuthenticated } = useAuth();
    const [ready, setReady] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [loading, setLoading] = useState(true);

    const checkStatus = useCallback(async () => {
        if (!isAuthenticated || dismissed) {
            setLoading(false);
            return;
        }
        try {
            const { ready } = await api.getLastfmNudgeStatus();
            setReady(ready);
        } catch {
            // Nudge endpoint is optional/young — treat as not ready.
        } finally {
            setLoading(false);
        }
    }, [isAuthenticated, dismissed]);

    useEffect(() => {
        setDismissed(false);
        setLoading(true);
        checkStatus();
    }, [checkStatus]);

    const dismiss = useCallback(async () => {
        setDismissed(true);
        try {
            await api.acknowledgeLastfmNudge();
        } catch {
            // Ack is best-effort; caller stays dismissed anyway.
        }
        onDismiss?.();
    }, [onDismiss]);

    return { ready, dismissed, loading, dismiss, setReady: setReady };
}