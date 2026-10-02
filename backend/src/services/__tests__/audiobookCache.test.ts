/**
 * syncAll refreshes `sortName` from `title` on both create and update, since
 * `GET /audiobooks` orders on it and titles can change upstream.
 */

jest.mock("../../utils/db", () => ({
    prisma: {
        audiobook: {
            upsert: jest.fn().mockResolvedValue({}),
            // syncAll's prune pass calls deleteMany after the
            // upsert loop; not the subject of this file's assertions.
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../audiobookshelf", () => ({
    audiobookshelfService: { getAllAudiobooks: jest.fn() },
}));

import { audiobookCacheService } from "../audiobookCache";
import { audiobookshelfService } from "../audiobookshelf";
import { prisma } from "../../utils/db";

afterEach(() => jest.restoreAllMocks());

function minimalBook(id: string, title: string) {
    return {
        id,
        libraryId: "lib1",
        media: { metadata: { title, authorName: "Some Author" } },
    };
}

describe("syncAll -- sortName kept in sync with title", () => {
    it("sets sortName, article-stripped, on both the create and update branch of the upsert", async () => {
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            minimalBook("book-1", "The Great Book"),
        ]);

        await audiobookCacheService.syncAll();

        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "book-1" },
                create: expect.objectContaining({ title: "The Great Book", sortName: "great book" }),
                update: expect.objectContaining({ title: "The Great Book", sortName: "great book" }),
            }),
        );
    });

    it("leaves a title with no leading article unchanged", async () => {
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            minimalBook("book-2", "Dune"),
        ]);

        await audiobookCacheService.syncAll();

        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ sortName: "dune" }),
                update: expect.objectContaining({ sortName: "dune" }),
            }),
        );
    });
});
