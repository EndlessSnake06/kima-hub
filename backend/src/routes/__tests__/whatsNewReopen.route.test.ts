/**
 * Reading the current release again after closing it, through the real auth
 * middleware and database: it leaves the pending list but is still read in
 * full, with this user's items and each answered choice as it now stands.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import whatsNewRoutes from "../whatsNew";
import { GPU_CHOICE_KEY, RELEASES } from "../../services/releases/catalog";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "whatsnew_reopen_user";
const ADMIN = "whatsnew_reopen_admin";
const newest = [...RELEASES].sort((a, b) => (a.date === b.date ? a.version.localeCompare(b.version) : a.date < b.date ? -1 : 1)).at(-1)!;

function app() {
    const a = express();
    a.use(express.json());
    a.use("/whats-new", whatsNewRoutes);
    return a;
}

const as = (id: string, role: "user" | "admin") => `Bearer ${generateToken({ id, username: id, role, tokenVersion: 0 })}`;

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
    await closeEngineConnections();
});

it("reads the closed current release again, with only this user's items", async () => {
    expect((await request(app()).post(`/whats-new/${newest.version}/dismiss`).set("Authorization", as(USER, "user")).send({})).status).toBe(200);

    const pending = await request(app()).get("/whats-new/pending").set("Authorization", as(USER, "user"));
    expect(pending.body.releases.map((r: { version: string }) => r.version)).not.toContain(newest.version);

    const again = await request(app()).get("/whats-new/current").set("Authorization", as(USER, "user"));
    expect(again.status).toBe(200);
    expect(again.body.release.version).toBe(newest.version);
    expect(again.body.release.items.some((i: { requires?: string }) => i.requires === "admin")).toBe(false);
});

it("gives an admin the admin items, with the GPU answer as the setting stands", async () => {
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", gpuOnnxEnabled: true }, update: { gpuOnnxEnabled: true } });
    invalidateSystemSettingsCache();

    const again = await request(app()).get("/whats-new/current").set("Authorization", as(ADMIN, "admin"));

    expect(again.status).toBe(200);
    expect(again.body.release.items.some((i: { key: string }) => i.key === GPU_CHOICE_KEY)).toBe(true);
    expect(again.body.answers[GPU_CHOICE_KEY]).toBe(true);
});

it("needs a signed-in user", async () => {
    expect((await request(app()).get("/whats-new/current")).status).toBe(401);
});
