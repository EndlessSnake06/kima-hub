/**
 * syncAll removes books Audiobookshelf no longer has, refuses to prune on an
 * empty list, deletes isMissing books, and parses "(2008)" as 2008.
 */

jest.mock("../../utils/db", () => ({
    prisma: {
        audiobook: {
            upsert: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../config", () => ({
    config: { music: { musicPath: "/music" } },
}));

jest.mock("../audiobookshelf", () => ({
    audiobookshelfService: { getAllAudiobooks: jest.fn() },
}));

import { audiobookCacheService } from "../audiobookCache";
import { audiobookshelfService } from "../audiobookshelf";
import { prisma } from "../../utils/db";

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(audiobookCacheService as any, "ensureCoverCacheDir").mockResolvedValue(false);
});

afterEach(() => jest.restoreAllMocks());

function minimalBook(id: string, title: string) {
    return {
        id,
        libraryId: "lib1",
        media: { metadata: { title, authorName: "Some Author" } },
    };
}

describe("syncAll -- prune pass", () => {
    it("deletes rows whose ids are not in ABS's live set", async () => {
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            minimalBook("live-1", "Book One"),
        ]);
        (prisma.audiobook.deleteMany as jest.Mock).mockResolvedValue({ count: 3 });

        const result = await audiobookCacheService.syncAll();

        expect(prisma.audiobook.deleteMany).toHaveBeenCalledWith({
            where: { id: { notIn: ["live-1"] } },
        });
        expect(result.pruned).toBe(3);
    });

    it("refuses to prune when ABS returns an empty list (failed fetch must not wipe the library)", async () => {
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([]);

        const result = await audiobookCacheService.syncAll();

        expect(prisma.audiobook.deleteMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: expect.objectContaining({ notIn: [] }) } }),
        );
        expect(result.pruned).toBe(0);
    });

    it("deletes an isMissing book instead of skipping it", async () => {
        const missing = { ...minimalBook("gone-1", "Vanished"), isMissing: true };
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            minimalBook("live-1", "Book One"),
            missing,
        ]);
        (prisma.audiobook.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

        await audiobookCacheService.syncAll();

        // the isMissing deletion is its own deleteMany on the exact id
        expect(prisma.audiobook.deleteMany).toHaveBeenCalledWith({
            where: { id: "gone-1" },
        });
    });

    it("parses bracketed years: '(2008)' -> 2008, not null", async () => {
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            {
                ...minimalBook("y1", "Saturn's Children"),
                media: {
                    metadata: { title: "Saturn's Children", authorName: "C Stross", publishedYear: "(2008)" },
                },
            },
        ]);

        await audiobookCacheService.syncAll();

        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "y1" },
                create: expect.objectContaining({ publishedYear: 2008 }),
            }),
        );
    });
});
