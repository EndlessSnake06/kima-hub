"use client";

import { useEffect, useState } from "react";
import {
    readIosAudioLog,
    clearIosAudioLog,
    isIosAudioDebugEnabled,
} from "@/lib/iosAudioLog";

export default function IosLogPage() {
    const [enabled] = useState(() => isIosAudioDebugEnabled());
    const [events, setEvents] = useState<ReturnType<typeof readIosAudioLog>>([]);
    const [uploadStatus, setUploadStatus] = useState<string | null>(null);

    useEffect(() => {
        const id = setInterval(() => {
            setEvents(readIosAudioLog());
        }, 500);
        return () => clearInterval(id);
    }, []);

    if (!enabled) {
        return (
            <div style={{ padding: 24, fontFamily: "system-ui" }}>
                <h1>iOS Audio Log</h1>
                <p>Debug mode not enabled. Visit this page from an iPhone with{" "}
                    <code>?ios_debug=1</code> appended to the URL first.</p>
            </div>
        );
    }

    async function upload() {
        try {
            const res = await fetch("/api/debug/ios-log", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ events }),
            });
            setUploadStatus(res.ok ? "Uploaded" : `Upload failed (${res.status})`);
        } catch {
            setUploadStatus("Upload failed");
        }
    }

    return (
        <div style={{ padding: 16, fontFamily: "system-ui", fontSize: 12 }}>
            <h1>iOS Audio Log ({events.length} events)</h1>
            <button onClick={() => navigator.clipboard.writeText(JSON.stringify(events, null, 2))}>
                Copy
            </button>{" "}
            <button onClick={upload}>Upload</button>{" "}
            <button onClick={() => { clearIosAudioLog(); setEvents([]); }}>
                Clear
            </button>
            {uploadStatus && <span role="status"> {uploadStatus}</span>}
            <table style={{ width: "100%", marginTop: 16, fontFamily: "monospace" }}>
                <thead>
                    <tr>
                        <th align="left">t</th>
                        <th align="left">name</th>
                        <th align="left">site</th>
                        <th align="left">paused</th>
                        <th align="left">cT</th>
                        <th align="left">rs</th>
                        <th align="left">vis</th>
                        <th align="left">extra</th>
                    </tr>
                </thead>
                <tbody>
                    {events.slice().reverse().map((e, i) => (
                        <tr key={i}>
                            <td>{new Date(e.t).toISOString().slice(11, 23)}</td>
                            <td>{e.name}</td>
                            <td>{e.site}</td>
                            <td>{String(e.paused)}</td>
                            <td>{e.currentTime?.toFixed?.(2)}</td>
                            <td>{e.readyState}</td>
                            <td>{e.visibility}</td>
                            <td>{e.extra ? JSON.stringify(e.extra) : ""}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
