/**
 * The public library export against a real database: only owned, present,
 * mapped tracks are included, each with its nearest such tracks by cosine, and
 * the ETag holds until the library changes, and readers are served the last
 * finished export while a rebuild runs.
 */
import zlib from "zlib";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { latestLibraryExport, refreshLibraryExport } from "../publicLibraryExport";

jest.setTimeout(60_000);

const DIM = 512;

function axis(...weights: Array<[number, number]>): string {
    const v = new Array(DIM).fill(0);
    for (const [d, w] of weights) v[d] = w;
    return `[${v.join(",")}]`;
}

async function addTrack(
    id: string,
    albumId: string,
    embedding?: string,
    xyz?: [number, number, number],
    missingSince: Date | null = null,
) {
    await prisma.track.create({
        data: {
            id, albumId, title: `T ${id}`, trackNo: 1, duration: 200, energy: 0.71234, valence: 0.2,
            filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000, missingSince,
        },
    });
    if (!embedding) return;
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, map_x, map_y, map_z)
         VALUES ($1, $2::vector, 'clap-test', $3, $4, $5)`,
        id, embedding, xyz?.[0] ?? null, xyz?.[1] ?? null, xyz?.[2] ?? null,
    );
}

function unpack(gzipped: Buffer) {
    return JSON.parse(zlib.gunzipSync(gzipped).toString());
}

const original = config.publicVibe;

beforeAll(async () => {
    config.publicVibe = { token: "t".repeat(32), username: "Vibe Tester" };
    await prisma.artist.create({ data: { id: "art_pub", name: "Pub Artist", identityKey: "a_pub" } });
    await prisma.album.create({
        data: { id: "alb_pub", rgMbid: "rg_pub", artistId: "art_pub", title: "Pub Album", year: 2001, primaryType: "Album" },
    });
    await addTrack("trk_a", "alb_pub", axis([0, 1]), [0.1, 0.2, 0.3]);
    await addTrack("trk_b", "alb_pub", axis([0, 1], [1, 0.2]), [0.11, 0.21, 0.31]);
    await addTrack("trk_c", "alb_pub", axis([1, 1]), [0.9, 0.8, 0.7]);
    await addTrack("trk_unmapped", "alb_pub", axis([0, 1]));
    await addTrack("trk_unanalysed", "alb_pub");
    await prisma.album.create({
        data: { id: "alb_disc", rgMbid: "rg_disc", identityKey: "al_disc", artistId: "art_pub", title: "Suggested", primaryType: "Album", location: "DISCOVER" },
    });
    await addTrack("trk_suggested", "alb_disc", axis([0, 1], [2, 0.01]), [0.1, 0.2, 0.3]);
    await addTrack("trk_missing", "alb_pub", axis([0, 1], [3, 0.01]), [0.1, 0.2, 0.3], new Date());
});

afterAll(async () => {
    config.publicVibe = original;
    // The test DB is shared by every file in the run; these ids are not
    // prefixed, so they are listed and removed one by one.
    await prisma.$executeRawUnsafe(
        `DELETE FROM track_embeddings WHERE track_id = ANY($1)`,
        ["trk_a", "trk_b", "trk_c", "trk_unmapped", "trk_unanalysed", "trk_suggested", "trk_missing"],
    );
    await prisma.$executeRawUnsafe(
        `DELETE FROM "Track" WHERE id = ANY($1)`,
        ["trk_a", "trk_b", "trk_c", "trk_unmapped", "trk_unanalysed", "trk_suggested", "trk_missing"],
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = ANY($1)`, ["alb_pub", "alb_disc"]);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, "art_pub");
});

describe("public library export", () => {
    it("has nothing to serve until the first build finishes", async () => {
        expect(latestLibraryExport()).toBeNull();
        const built = await refreshLibraryExport();
        expect(latestLibraryExport()).toBe(built);
    });

    it("lists the mapped tracks with their nearest mapped tracks", async () => {
        const doc = unpack((await refreshLibraryExport()).gzipped);
        expect(doc.version).toBe(1);
        expect(doc.library).toEqual({ id: "vibe-tester", name: "Vibe Tester", engine: { analyzer: null, embedding: "clap-test" } });
        expect(doc.artists).toEqual([{ id: "art_pub", name: "Pub Artist" }]);
        expect(doc.albums).toEqual([{ id: "alb_pub", artistId: "art_pub", title: "Pub Album", year: 2001 }]);
        expect(doc.tracks.map((t: any) => t.id)).toEqual(["trk_a", "trk_b", "trk_c"]);
        expect(doc.excluded).toBe(2);

        const a = doc.tracks[0];
        expect(a).toMatchObject({ xyz: [0.1, 0.2, 0.3], duration: 200, energy: 0.712, valence: 0.2 });
        expect(a.neighbours.map(([id]: [string]) => id)).toEqual(["trk_b", "trk_c"]);
        expect(a.neighbours[0][1]).toBeCloseTo(1 / Math.sqrt(1.04), 4);
        expect(a.neighbours[1][1]).toBe(0);
    });

    it("keeps its ETag and its bytes while nothing changes", async () => {
        const first = await refreshLibraryExport();
        const second = await refreshLibraryExport();
        expect(second.etag).toBe(first.etag);
        expect(second.gzipped).toBe(first.gzipped);
    });

    it("serves the last export without waiting while a rebuild runs", async () => {
        const before = await refreshLibraryExport();
        await prisma.$executeRawUnsafe(`UPDATE track_embeddings SET map_z = 0.4 WHERE track_id = 'trk_c'`);
        expect(latestLibraryExport()).toBe(before);
        const after = await refreshLibraryExport();
        expect(after.etag).not.toBe(before.etag);
        expect(latestLibraryExport()).toBe(after);
        await refreshLibraryExport();
    });

    it("rebuilds when a track moves on the map", async () => {
        const before = await refreshLibraryExport();
        await prisma.$executeRawUnsafe(`UPDATE track_embeddings SET map_x = 0.5 WHERE track_id = 'trk_c'`);
        const after = await refreshLibraryExport();
        expect(after.etag).not.toBe(before.etag);
        expect(unpack(after.gzipped).tracks[2].xyz[0]).toBe(0.5);
    });

    it("rebuilds when an album is renamed", async () => {
        const before = await refreshLibraryExport();
        await prisma.album.update({ where: { id: "alb_pub" }, data: { title: "Renamed" } });
        const after = await refreshLibraryExport();
        expect(after.etag).not.toBe(before.etag);
        expect(unpack(after.gzipped).albums[0].title).toBe("Renamed");
    });

    it("gives concurrent callers one build", async () => {
        await prisma.$executeRawUnsafe(`UPDATE track_embeddings SET map_y = 0.6 WHERE track_id = 'trk_c'`);
        const [x, y] = await Promise.all([refreshLibraryExport(), refreshLibraryExport()]);
        expect(x.gzipped).toBe(y.gzipped);
    });

    it("takes in a suggested album once it is owned, and a missing file once it is found", async () => {
        const before = await refreshLibraryExport();
        await prisma.album.update({ where: { id: "alb_disc" }, data: { location: "LIBRARY" } });
        await prisma.track.update({ where: { id: "trk_missing" }, data: { missingSince: null } });
        const after = await refreshLibraryExport();
        expect(after.etag).not.toBe(before.etag);
        const doc = unpack(after.gzipped);
        expect(doc.tracks.map((t: any) => t.id)).toEqual(["trk_a", "trk_b", "trk_c", "trk_missing", "trk_suggested"]);
        expect(doc.excluded).toBe(2);
        expect(doc.tracks[0].neighbours.map(([id]: [string]) => id).slice(0, 2).sort()).toEqual(["trk_missing", "trk_suggested"]);
    });
});
