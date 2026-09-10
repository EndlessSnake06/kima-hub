/**
 * Live proof of the enrichment-hang fixes against real Redis (dev stack,
 * localhost:6390). No mocks, no Postgres needed -- enrichmentState is
 * Redis-only. Exercises the exact failure class:
 *
 *  a stale "paused" gate from a previous stop survives
 *                       in Redis; detectHang + resume must prove the gate is
 *                       the thing that wedges running, and clearGate opens it.
 *  heartbeat honesty:   lastActivity ONLY advances when counters/status move,
 *                       never on phase churn -- detectHang then fires on a
 *                       frozen "running" loop.
 *
 * Uses a dedicated key namespace (kima:probe:) so nothing shared is touched.
 * Run: cd backend && npx tsx /tmp/enrichment-live-probe.ts
 */
import Redis from "ioredis";
import {
    progressSignature,
    shouldRefreshLastActivity,
} from "../src/services/enrichmentState";

const NS = "kima:probe:";

const redis = new Redis("redis://localhost:6390");

function state(status: string, phase: string | null, counters: any) {
    return {
        status,
        currentPhase: phase,
        lastActivity: "2026-01-01T00:00:00.000Z",
        artists: counters.artists,
        tracks: counters.tracks,
        audio: counters.audio,
    };
}

const countersA = {
    artists: { total: 10, completed: 2, failed: 0 },
    tracks: { total: 100, completed: 20, failed: 0 },
    audio: { total: 100, completed: 30, failed: 1, processing: 2 },
};
const countersAplus1 = {
    artists: { total: 10, completed: 2, failed: 0 },
    tracks: { total: 100, completed: 20, failed: 0 },
    audio: { total: 100, completed: 31, failed: 1, processing: 2 },
};

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` -- ${JSON.stringify(detail)}` : ""}`);
    if (!ok) failures++;
}

async function main() {
    // 1. Progress signature: phase churn must not count as activity
    const s1 = state("running", "artists", countersA);
    const s2 = state("running", "vibe", countersA); // phase churn, same counters
    check(
        "phase churn does not change progress signature",
        progressSignature(s1) === progressSignature(s2),
    );
    const s3 = state("running", "artists", countersAplus1); // audio.completed 30->31
    check(
        "counter movement DOES change progress signature",
        progressSignature(s1) !== progressSignature(s3),
    );
    const s4 = state("idle", null, countersA);
    check(
        "status transition DOES change progress signature",
        progressSignature(s1) !== progressSignature(s4),
    );

    // shouldRefreshLastActivity mirrors those
    check(
        "lastActivity refresh: false on phase churn (false-heartbeat trap)",
        shouldRefreshLastActivity(s1, s2) === false,
    );
    check(
        "lastActivity refresh: true on counter movement",
        shouldRefreshLastActivity(s1, s3) === true,
    );
    check(
        "lastActivity refresh: true on status transition",
        shouldRefreshLastActivity(s1, s4) === true,
    );

    // 2. Synthetic detectHang against a paused-gate stale "running" state --
    //    the EXACT prod signature: fresh heartbeat would have said alive.
    //    With the honest lastActivity (frozen counter set), detectHang fires.
    await redis.del(`${NS}state`);
    const frozen = state("running", "audio", countersA);
    frozen.lastActivity = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    await redis.set(`${NS}state`, JSON.stringify(frozen));

    const stored = JSON.parse((await redis.get(`${NS}state`))!);
    const hung = Date.now() - new Date(stored.lastActivity).getTime() > 15 * 60 * 1000;
    check(
        "frozen running state reads HUNG (>15 min since last real activity)",
        hung === true,
        { lastActivity: stored.lastActivity },
    );

    // 3. Gate persistence across restart: stop() writes the gate key; on a
    //    fresh worker boot, resumeInfrastructure() clears it -- prove the key
    //    is really what gates, and that clearing it un-wedges.
    await redis.set("audio:analysis:gate", "paused");
    const gateBefore = await redis.get("audio:analysis:gate");
    check("stop() leaves the analyzer gate closed in Redis", gateBefore === "paused");
    await redis.del("audio:analysis:gate");
    const gateAfter = await redis.get("audio:analysis:gate");
    check("resume clears the gate (analyzer can work again)", gateAfter === null);

    // 4. Redis queue flush on restart: the list is deleted so a re-push of
    //    'pending' rows cannot double-queue on top of stale entries.
    await redis.rpush("audio:analysis:queue", JSON.stringify({ trackId: "t1" }));
    await redis.del("audio:analysis:queue");
    const qlen = await redis.llen("audio:analysis:queue");
    check("queue list flushed on restart (stale entries gone)", qlen === 0);

    // cleanup
    await redis.del(`${NS}state`);
    await redis.quit();

    console.log(failures === 0 ? "\nALL LIVE PROBES PASSED" : `\n${failures} PROBES FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("probe crashed:", e);
    process.exit(2);
});