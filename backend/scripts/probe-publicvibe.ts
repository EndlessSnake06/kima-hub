// Bare probe: boot the REAL publicVibe router on localhost, hit it, dump the
// raw response. No supertest, no jest, so nothing about the framework can
// mask what's happening. Runs via tsx (already installed).
// Usage: tsx scripts/probe-publicvibe.ts
import http from "http";
import express from "express";
import publicVibeRouter, { __resetPublicAccess } from "../src/routes/publicVibe";

const app = express();
app.use(express.json());
app.use("/api/public/vibe", publicVibeRouter);

const server = app.listen(0, async () => {
    const port = (server.address() as any).port;
    // eslint-disable-next-line no-console
    console.log("listening on", port);

    async function hit(path: string, opts: any = {}) {
        const r = await new Promise<{ code: number; ctype: string; body: string; stack: string }>((resolve) => {
            const req = http.request(
                { host: "127.0.0.1", port, path, method: "GET", ...opts },
                (res) => {
                    let b = "";
                    res.on("data", (c) => (b += c));
                    res.on("end", () =>
                        resolve({ code: res.statusCode!, ctype: res.headers["content-type"] || "", body: b, stack: "" }),
                    );
                },
            );
            req.on("error", (e) => resolve({ code: -1, ctype: "", body: String(e), stack: String(e.stack || e) }));
            req.end();
        });
        return r;
    }

    // Enabled path
    __resetPublicAccess();

    // Simulate an enabled read by monkeypatching nothing; instead just observe.
    console.log("--- /live ---");
    const live = await hit("/api/public/vibe/live");
    console.log("code:", live.code, "ctype:", live.ctype);
    console.log("body:", live.body);

    console.log("--- /map ---");
    const map = await hit("/api/public/vibe/map?limit=10");
    console.log("code:", map.code, "ctype:", map.ctype);
    console.log("body:", map.body.slice(0, 200));

    console.log("--- /similar/c_t_neighbor ---");
    const sim = await hit("/api/public/vibe/similar/c_t_neighbor");
    console.log("code:", sim.code, "ctype:", sim.ctype);
    console.log("body:", sim.body.slice(0, 200));

    server.close();
    process.exit(0);
});
