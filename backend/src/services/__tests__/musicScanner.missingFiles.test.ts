/**
 * a library scan whose file has vanished must never delete the
 * Track row ("a track whose file is missing
 * is never deleted — its flag is set and its true state shown").
 *
 * The old Step 4 ran `prisma.track.deleteMany` over every track whose file
 * did not come back in the walk. A NAS hiccup therefore erased listens
 * (Play), likes (LikedTrack), every stage answer (TrackStage) and the
 * embedding (track_embeddings) through the cascade — and the next scan
 * re-created the row as if the library had never heard the file.
 *
 * These tests run the REAL scanner against a REAL temp directory and the
 * REAL test database: the point is that the row and everything recorded
 * against it survive a vanished file, that the missing flag is set with the
 * time the file was found missing, and that a later scan with the file back
 * clears the flag again.
 *
 * Externals that do not belong to this contract are mocked at the boundary:
 * tag parsing (music-metadata is pure ESM; the jest map provides a stub we
 * program per test), the fpcalc/acoustid stack (the seeded MBID tag takes
 * the identification path away from them), cover art, and the artist-count
 * backfill (a whole-library job).
 *
 * Run: cd backend && npx jest src/services/__tests__/musicScanner.missingFiles.test.ts --forceExit --maxWorkers=1
 */

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn().mockResolvedValue({
            musicCNN: false,
            vibeEmbeddings: false,
            audiobookshelfEnabled: false,
            fpcalc: false,
        }),
    },
}));
jest.mock("../../services/acoustidService", () => ({
    acoustidService: { lookup: jest.fn().mockResolvedValue(null) },
}));
jest.mock("../../services/fpcalc", () => ({
    fpcalcService: {
        isAvailable: jest.fn().mockResolvedValue(false),
        fingerprintFile: jest.fn().mockResolvedValue(null),
    },
}));
jest.mock("../../services/coverArtExtractor", () => ({
    CoverArtExtractor: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../services/artwork", () => ({
    findAlbumArtwork: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../services/artistCountsService", () => ({
    backfillAllArtistCounts: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/imageStorage", () => ({
    checkLocalArtistImage: jest.fn().mockResolvedValue(null),
}));

import fs from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { MusicScannerService } from "../musicScanner";

jest.setTimeout(60_000);

const ARTIST_NAME = "Scanmiss Artist";
const ALBUM_TITLE = "Scanmiss Album";
const RG_MBID = "rg-scanmiss-1";
const TRACK_TITLE = "Keep";
const USER = "scanmiss_user";
// The scanner keys every row on the file's path relative to the music root.
const REL = path.join("Artist", "Album", "01 - Keep.flac");

let musicDir: string;
let trackFile: string;

function writeFile(): void {
    fs.mkdirSync(path.dirname(trackFile), { recursive: true });
    fs.writeFileSync(trackFile, "dummy audio bytes");
}

function fakeMetadata() {
    return {
        common: {
            title: TRACK_TITLE,
            artist: ARTIST_NAME,
            albumartist: ARTIST_NAME,
            album: ALBUM_TITLE,
            track: { no: 1 },
            disk: { no: 1 },
            year: 2024,
            musicbrainz_releasegroupid: RG_MBID,
        },
        format: { duration: 180, codec: "flac" },
        native: {},
    };
}

async function findTrack() {
    return prisma.track.findUnique({ where: { filePath: REL } });
}

async function seedChildren(trackId: string): Promise<void> {
    await prisma.user.create({
        data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 },
    });
    await prisma.play.create({ data: { userId: USER, trackId } });
    await prisma.likedTrack.create({ data: { userId: USER, trackId } });
    await prisma.trackStage.create({
        data: {
            id: `${trackId}__recording`,
            trackId,
            stage: "recording",
            status: "done",
            source: "musicbrainz",
            attempt: 1,
            retryable: false,
            evidence: { question: "recording" },
        },
    });
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version)
         VALUES ($1, $2::vector, 'laion-clap-music')`,
        trackId,
        "[" + Array.from({ length: 512 }, () => 0.1).join(",") + "]",
    );
}

async function wipe(): Promise<void> {
    // Track deletion cascades to play/liked/stage/embedding. The rows are
    // wiped by the values the scan itself wrote, since the ids are cuids.
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "filePath" = $1`, REL);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE "rgMbid" = $1`, RG_MBID);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name = $1`, ARTIST_NAME);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, USER);
}

beforeEach(async () => {
    await wipe();

    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanmiss-"));
    trackFile = path.join(musicDir, REL);
    writeFile();

    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockResolvedValue(fakeMetadata());
});

afterEach(() => {
    fs.rmSync(musicDir, { recursive: true, force: true });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("scan with a vanished file", () => {
    it("keeps the Track row, flags it missing with the found-missing time, and preserves its plays, likes, stage answer and embedding", async () => {
        const scanner = new MusicScannerService();

        // Scan 1: the file exists, the track is added clean.
        const first = await scanner.scanLibrary(musicDir);
        expect(first.tracksAdded).toBe(1);
        const added = await findTrack();
        expect(added).not.toBeNull();
        expect(added?.missingSince).toBeNull();
        const trackId = added!.id;

        // Real history accumulates against the row.
        await seedChildren(trackId);

        // The NAS hiccup: the file vanishes between scans.
        fs.unlinkSync(trackFile);

        const beforeMissing = new Date();
        const second = await scanner.scanLibrary(musicDir);
        const afterMissing = new Date();

        // The row is NEVER deleted.
        const kept = await findTrack();
        expect(kept).not.toBeNull();
        expect(kept?.title).toBe(TRACK_TITLE);

        // The flag is the truth: missing, since the scan that found it gone.
        expect(kept?.missingSince).not.toBeNull();
        const missingSince = kept?.missingSince as Date;
        expect(missingSince.getTime()).toBeGreaterThanOrEqual(
            beforeMissing.getTime() - 1000
        );
        expect(missingSince.getTime()).toBeLessThanOrEqual(
            afterMissing.getTime() + 1000
        );

        // Nothing recorded against the track was cascaded away.
        expect(await prisma.play.count({ where: { trackId } })).toBe(1);
        expect(await prisma.likedTrack.count({ where: { trackId } })).toBe(1);
        expect(
            await prisma.trackStage.findUnique({
                where: { id: `${trackId}__recording` },
            })
        ).not.toBeNull();
        expect(
            await prisma.$queryRawUnsafe<Array<{ n: number }>>(
                `SELECT count(*)::int AS n FROM track_embeddings WHERE track_id = $1`,
                trackId
            )
        ).toEqual([{ n: 1 }]);

        // The scan reports the truth instead of a deletion.
        expect(second.tracksMissing).toBe(1);
    });

    it("clears the missing flag when a later scan finds the file again", async () => {
        const scanner = new MusicScannerService();

        const first = await scanner.scanLibrary(musicDir);
        expect(first.tracksAdded).toBe(1);
        const trackId = (await findTrack())!.id;
        await seedChildren(trackId);

        // Gone...
        fs.unlinkSync(trackFile);
        await scanner.scanLibrary(musicDir);
        expect((await findTrack())?.missingSince).not.toBeNull();

        // ...and back. The same relative path, a fresh file.
        writeFile();

        const third = await scanner.scanLibrary(musicDir);

        const row = await findTrack();
        expect(row).not.toBeNull();
        expect(row?.missingSince).toBeNull();
        // And the scan says so.
        expect(third.tracksMissing).toBe(0);
    });
});
