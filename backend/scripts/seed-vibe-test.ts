/**
 * Seed a small set of tracks with varied mood profiles + UMAP positions
 * so the /api/vibe/map projection and the galaxy view have something to render.
 *
 * Run: npx tsx backend/scripts/seed-vibe-test.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";

const prisma = new PrismaClient();

// Helper to hash a plain password with bcrypt (same as the backend login flow).
async function bcryptHash(password: string): Promise<string> {
    const bcrypt = await import("bcrypt");
    return bcrypt.default.hash(password, 10);
}

async function main() {
    await prisma.$connect();

    // 1. Create the test user (same schema as the create-e2e-user script).
    const testUser = await prisma.user.upsert({
        where: { username: "kima_test" },
        update: {},
        create: {
            username: "kima_test",
            passwordHash: await bcryptHash("kima_test_pw"),
        },
    });
    console.log("user:", testUser.id);

    // 2. Insert a small library of tracks with diverse moods.
    //    Each track gets a real-looking UMAP (x,y) in [0,1] and a 7-key moods
    //    record so the galaxy renders at least two visually distinct mood regions.
    const dummyAlbumId = randomUUID();
    const dummyArtistId = randomUUID();

    await prisma.album.upsert({
        where: { id: dummyAlbumId },
        update: {},
        create: {
            id: dummyAlbumId,
            title: "Test Mood Galaxy",
            artistId: dummyArtistId,
            releaseDate: new Date(),
        },
    });

    await prisma.artist.upsert({
        where: { id: dummyArtistId },
        update: {},
        create: {
            id: dummyArtistId,
            name: "Test Artist",
        },
    });

    const tracks = [
        // { id, title, x, y, moods (7 keys), energy, valence }
        { id: randomUUID(), title: "Sunny Happy Day", x: 0.1, y: 0.2, moods: { moodHappy: 0.9, moodSad: 0.05, moodRelaxed: 0.1, moodAggressive: 0.02, moodParty: 0.3, moodAcoustic: 0.15, moodElectronic: 0.05 }, energy: 0.7, valence: 0.8 },
        { id: randomUUID(), title: "Melancholy Rain", x: 0.2, y: 0.8, moods: { moodHappy: 0.05, moodSad: 0.85, moodRelaxed: 0.3, moodAggressive: 0.05, moodParty: 0.02, moodAcoustic: 0.4, moodElectronic: 0.05 }, energy: 0.3, valence: 0.2 },
        { id: randomUUID(), title: "Chill Waves", x: 0.5, y: 0.5, moods: { moodHappy: 0.2, moodSad: 0.1, moodRelaxed: 0.8, moodAggressive: 0.05, moodParty: 0.1, moodAcoustic: 0.5, moodElectronic: 0.2 }, energy: 0.4, valence: 0.5 },
        { id: randomUUID(), title: "Aggressive Beats", x: 0.8, y: 0.3, moods: { moodHappy: 0.1, moodSad: 0.05, moodRelaxed: 0.1, moodAggressive: 0.85, moodParty: 0.4, moodAcoustic: 0.05, moodElectronic: 0.3 }, energy: 0.9, valence: 0.4 },
        { id: randomUUID(), title: "Party Night", x: 0.9, y: 0.8, moods: { moodHappy: 0.5, moodSad: 0.02, moodRelaxed: 0.1, moodAggressive: 0.1, moodParty: 0.9, moodAcoustic: 0.05, moodElectronic: 0.6 }, energy: 0.85, valence: 0.7 },
        { id: randomUUID(), title: "Acoustic Morning", x: 0.15, y: 0.6, moods: { moodHappy: 0.3, moodSad: 0.1, moodRelaxed: 0.4, moodAggressive: 0.02, moodParty: 0.05, moodAcoustic: 0.85, moodElectronic: 0.05 }, energy: 0.35, valence: 0.55 },
        { id: randomUUID(), title: "Electric Dreams", x: 0.85, y: 0.15, moods: { moodHappy: 0.2, moodSad: 0.05, moodRelaxed: 0.2, moodAggressive: 0.15, moodParty: 0.5, moodAcoustic: 0.05, moodElectronic: 0.9 }, energy: 0.8, valence: 0.6 },
        { id: randomUUID(), title: "Deep Relaxation", x: 0.4, y: 0.9, moods: { moodHappy: 0.1, moodSad: 0.2, moodRelaxed: 0.9, moodAggressive: 0.02, moodParty: 0.05, moodAcoustic: 0.3, moodElectronic: 0.15 }, energy: 0.2, valence: 0.4 },
        { id: randomUUID(), title: "Happy Electronic", x: 0.7, y: 0.45, moods: { moodHappy: 0.6, moodSad: 0.03, moodRelaxed: 0.15, moodAggressive: 0.08, moodParty: 0.6, moodAcoustic: 0.1, moodElectronic: 0.7 }, energy: 0.75, valence: 0.7 },
        { id: randomUUID(), title: "Sad Acoustic Ballad", x: 0.25, y: 0.7, moods: { moodHappy: 0.05, moodSad: 0.75, moodRelaxed: 0.25, moodAggressive: 0.03, moodParty: 0.02, moodAcoustic: 0.7, moodElectronic: 0.05 }, energy: 0.25, valence: 0.15 },
        { id: randomUUID(), title: "Party Start", x: 0.88, y: 0.85, moods: { moodHappy: 0.55, moodSad: 0.02, moodRelaxed: 0.08, moodAggressive: 0.12, moodParty: 0.92, moodAcoustic: 0.04, moodElectronic: 0.65 }, energy: 0.88, valence: 0.75 },
        { id: randomUUID(), title: "Midnight Chill", x: 0.55, y: 0.65, moods: { moodHappy: 0.15, moodSad: 0.15, moodRelaxed: 0.7, moodAggressive: 0.05, moodParty: 0.15, moodAcoustic: 0.25, moodElectronic: 0.4 }, energy: 0.45, valence: 0.45 },
    ];

    for (const t of tracks) {
        await prisma.track.upsert({
            where: { id: t.id },
            update: {},
            create: {
                id: t.id,
                albumId: dummyAlbumId,
                title: t.title,
                trackNo: 1,
                duration: 200,
                filePath: `/music/${t.title}.mp3`,
                fileModified: new Date(),
                fileSize: 1000000,
                energy: t.energy,
                valence: t.valence,
                moodHappy: t.moods.moodHappy,
                moodSad: t.moods.moodSad,
                moodRelaxed: t.moods.moodRelaxed,
                moodAggressive: t.moods.moodAggressive,
                moodParty: t.moods.moodParty,
                moodAcoustic: t.moods.moodAcoustic,
                moodElectronic: t.moods.moodElectronic,
            },
        });

        // Insert a random embedding (the UMAP worker will recompute map_x/map_y
        // on next enrichment, but the hydrate path reads these directly).
        await prisma.trackEmbedding.upsert({
            where: { track_id: t.id },
            update: {},
            create: {
                track_id: t.id,
                map_x: t.x,
                map_y: t.y,
            },
        });
    }

    console.log(`Seeded ${tracks.length} tracks with mood profiles.`);
    console.log("You can now view /vibe (map + galaxy) with the test user: kima_test / kima_test_pw");
}

main()
    .then(() => prisma.$disconnect())
    .catch((e) => {
        console.error("Seed failed:", e);
        prisma.$disconnect();
        process.exit(1);
    });
