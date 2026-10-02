"use client";

import { useEffect } from "react";
import { applyIosDebugQueryFlag } from "@/lib/iosAudioLog";

export function ServiceWorkerRegistration() {
    useEffect(() => {
        applyIosDebugQueryFlag();
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register("/sw.js").catch(() => {});
        }
    }, []);

    return null;
}
