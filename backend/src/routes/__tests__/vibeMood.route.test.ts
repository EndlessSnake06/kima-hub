/**
 * GET /api/vibe/mood/:trackId answers with the mood that colours the track's
 * star on the map, read from the real library through a real sign-in.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import vibeRouter from "../vibe";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";

const P = "cvmood";
const MOODS = ["moodHappy", "moodSad", "moodRelaxed", "moodAggressive", "moodParty"] as const;

function moods(strong?: (typeof MOODS)[number]) {
    return Object.fromEntries(MOODS.map((m) => [m, m === strong ? 0.95 : 0.1]));
}

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE '${P}%'`);
}

let token: string;

beforeAll(async () => {
    await cleanup();
    const user = await prisma.user.create({
        data: { id: `${P}user`, username: `${P}user`, passwordHash: "x", role: "user" },
    });
    token = generateToken(user);
    await prisma.artist.create({ data: { id: `${P}art`, name: "Mood Artist", identityKey: `${P}-art` } });
    await prisma.album.create({ data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, title: "Mood Album", primaryType: "Album" } });
    const tracks: [string, Record<string, number | null>, string][] = [
        ["happy", moods("moodHappy"), "completed"],
        ["calm", moods("moodRelaxed"), "completed"],
        ["flat", moods(), "completed"],
        ["fresh", Object.fromEntries(MOODS.map((m) => [m, null])), "pending"],
    ];
    for (const [i, [name, values, status]] of tracks.entries()) {
        await prisma.track.create({
            data: {
                id: `${P}${name}`, albumId: `${P}alb`, title: name, trackNo: i + 1, duration: 200,
                filePath: `/tmp/${P}${name}.flac`, fileModified: new Date(), fileSize: 1000,
                analysisStatus: status, ...values,
            },
        });
    }
});

afterAll(async () => {
    await cleanup();
    await closeClient(redisClient);
});

function app() {
    const a = express();
    a.use("/api/vibe", vibeRouter);
    return a;
}

const mood = (id: string) =>
    request(app()).get(`/api/vibe/mood/${id}`).set("Authorization", `Bearer ${token}`);

describe("GET /api/vibe/mood/:trackId", () => {
    it("names the mood a track stands out on", async () => {
        expect((await mood(`${P}happy`)).body).toEqual({ dominantMood: "moodHappy" });
        expect((await mood(`${P}calm`)).body).toEqual({ dominantMood: "moodRelaxed" });
    });

    it("says no single mood when none stands out", async () => {
        expect((await mood(`${P}flat`)).body).toEqual({ dominantMood: "neutral" });
    });

    it("says not analysed for a track without moods yet", async () => {
        expect((await mood(`${P}fresh`)).body).toEqual({ dominantMood: "unanalyzed" });
    });

    it("refuses a request that is not signed in", async () => {
        const res = await request(app()).get(`/api/vibe/mood/${P}happy`);
        expect(res.status).toBe(401);
    });
});
