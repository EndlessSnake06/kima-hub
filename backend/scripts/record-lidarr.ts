/**
 * Records Kima's conversation with a Lidarr, for the download-pipeline tests:
 * a proxy that forwards every request to Lidarr and appends the exchange to
 * the recording named in <dir>/current (one JSON array per name). Headers are
 * not kept, so the API key never lands in a recording.
 *
 *   node scripts/record-lidarr.ts <lidarr url> <port> <dir>
 *
 * Runs on Node's own type stripping; point Kima's Lidarr URL at the proxy.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [target, port, dir] = process.argv.slice(2);
if (!target || !port || !dir) {
    console.error("usage: record-lidarr.ts <lidarr url> <port> <dir>");
    process.exit(1);
}

let seq = 0;

function parse(text: string): unknown {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function record(entry: Record<string, unknown>): void {
    const name = existsSync(join(dir, "current")) ? readFileSync(join(dir, "current"), "utf8").trim() : "";
    if (!name) return;
    const file = join(dir, `${name}.json`);
    const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    all.push(entry);
    writeFileSync(file, JSON.stringify(all, null, 1));
}

createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers[k] = v;
    }
    const at = new Date().toISOString();
    try {
        const upstream = await fetch(new URL(req.url ?? "/", target), {
            method: req.method,
            headers,
            body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
        });
        const text = await upstream.text();
        record({ seq: ++seq, at, method: req.method, path: req.url, request: parse(body), status: upstream.status, response: parse(text) });
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(text);
    } catch (error) {
        record({ seq: ++seq, at, method: req.method, path: req.url, request: parse(body), error: String(error) });
        res.writeHead(502);
        res.end();
    }
}).listen(Number(port), () => console.log(`recording ${target} on :${port} into ${dir}`));
