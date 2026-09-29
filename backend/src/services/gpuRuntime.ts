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
