import fs from "fs";
import path from "path";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { invalidateSystemSettingsCache } from "../utils/systemSettings";

// GPU-onnx toggle, backend half.
// The DB column is the toggle's truth; enabled.json is a projection for the
// analyzer (it must not read the DB to learn its own start-up env). The
// analyzer owns state.json — we only read it to answer the UI.

const ROOT = path.join(process.env.DATA_DIR || "/data", "gpu-onnx");
const STATE_PATH = path.join(ROOT, "state.json");
const ENABLED_PATH = path.join(ROOT, "enabled.json");
const CONTROL_CHANNEL = "audio:clap:control";

interface GpuState {
    status?: string;
    reason?: string | null;
    detail?: string | null;
    bytes?: number | null;
    pinned?: string[] | null;
    provider?: { active?: boolean } | null;
    updatedAt?: string;
}

function readJsonSafe<T>(filePath: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
        return null;
    }
}

function writeEnabledProjection(enabled: boolean): void {
    fs.mkdirSync(ROOT, { recursive: true });
    const tmp = ENABLED_PATH + ".tmp";
    fs.writeFileSync(
        tmp,
        JSON.stringify({ enabled, updatedAt: new Date().toISOString() }),
    );
    fs.renameSync(tmp, ENABLED_PATH);
}

export async function initGpuRuntimeProjection(): Promise<void> {
    try {
        const settings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { gpuOnnxEnabled: true },
        });
        writeEnabledProjection(Boolean(settings?.gpuOnnxEnabled));
    } catch (error) {
        logger.warn(`[GPU-onnx] boot projection skipped: ${String(error)}`);
    }
}

export async function getGpuStatus() {
    const settings = await prisma.systemSettings.findUnique({
        where: { id: "default" },
        select: { gpuOnnxEnabled: true },
    });
    const enabled = Boolean(settings?.gpuOnnxEnabled);
    const state = readJsonSafe<GpuState>(STATE_PATH) || {};
    const installed = state.status === "installed";
    const providerActive = state.provider?.active === true;
    return {
        enabled,
        installed,
        installing: state.status === "installing",
        effective: enabled && installed && providerActive,
        status: state.status || "idle",
        reason: state.reason ?? null,
        detail: state.detail ?? null,
        bytesDownloaded: state.bytes ?? null,
        pinned: state.pinned ?? [],
        providerActive,
        updatedAt: state.updatedAt ?? null,
    };
}

export async function setGpuEnabled(enabled: boolean) {
    // upsert, not update: SystemSettings has no row until something writes one.
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", gpuOnnxEnabled: enabled },
        update: { gpuOnnxEnabled: enabled },
    });
    invalidateSystemSettingsCache();
    writeEnabledProjection(enabled);
    const delivered = await redisClient.publish(
        CONTROL_CHANNEL,
        JSON.stringify({ command: enabled ? "install_gpu" : "remove_gpu" }),
    );
    logger.info(
        `[GPU-onnx] toggle ${enabled ? "on" : "off"} (control delivered to ${delivered} listener(s))`,
    );
    return getGpuStatus();
}

// --- Embedding deferral while the GPU runtime installs ---------------------
//
// "Yes, use the GPU" in the release window has to arrive BEFORE enrichment
// starts, or the first pass embeds the library on CPU anyway and the answer
// was worthless. So while the install is in flight, the engine holds embedding
// offers only — every other stage (analysis, fingerprint, metadata) keeps
// running. The hold is deliberately narrow and hard-bounded: a failed or hung
// download must never freeze the pipeline.
//
// The decision is a pure function so its whole truth table is testable;
// `embeddingsDeferredForGpu` is the thin IO shim around it.

export const GPU_INSTALL_HOLD_MS = 10 * 60 * 1000;

export function gpuDeferDecision(params: {
    enabled: boolean;
    status: string | null | undefined;
    enabledAtMs: number | null;
    nowMs: number;
    holdMs?: number;
}): boolean {
    if (!params.enabled) return false;
    const hold = params.holdMs ?? GPU_INSTALL_HOLD_MS;
    if (params.status === "installing") {
        // Installing is only worth waiting for inside the window; a download
        // still "installing" long after the toggle is a stuck one — CPU wins.
        return params.enabledAtMs !== null && params.nowMs - params.enabledAtMs <= hold;
    }
    // Between the toggle landing and the analyzer picking it up there is a gap
    // with no install state yet. Bridge it, but only inside the window.
    if (!params.status) {
        return params.enabledAtMs !== null && params.nowMs - params.enabledAtMs <= hold;
    }
    // installed / failed / any terminal status: no hold, never.
    return false;
}

let deferCache: { atMs: number; deferred: boolean } | null = null;
const DEFER_CACHE_MS = 5_000;

export async function embeddingsDeferredForGpu(now = new Date()): Promise<boolean> {
    if (deferCache && now.getTime() - deferCache.atMs < DEFER_CACHE_MS) return deferCache.deferred;
    let deferred = false;
    try {
        const settings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { gpuOnnxEnabled: true },
        });
        if (settings?.gpuOnnxEnabled) {
            const state = readJsonSafe<GpuState>(STATE_PATH) || {};
            const enabledAt = readJsonSafe<{ updatedAt?: string }>(ENABLED_PATH)?.updatedAt;
            deferred = gpuDeferDecision({
                enabled: true,
                status: state.status,
                enabledAtMs: enabledAt ? new Date(enabledAt).getTime() : null,
                nowMs: now.getTime(),
            });
        }
    } catch (error) {
        // A failed lookup must not stop enrichment; CPU proceeds.
        logger.warn(`[GPU-onnx] deferral check failed, not deferring: ${String(error)}`);
        deferred = false;
    }
    deferCache = { atMs: now.getTime(), deferred };
    return deferred;
}

/** Test seam: drop the 5s cache between cases. */
export function __resetGpuDeferCache(): void {
    deferCache = null;
}
