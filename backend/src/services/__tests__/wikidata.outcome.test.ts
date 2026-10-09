/**
 * A failed Wikidata lookup is not "no bio": it is never cached and the caller
 * keeps what it has. A genuine absence is cached like an answer. The image is
 * the claim Wikidata prefers, never a deprecated one.
 */
const mockGet = jest.fn();
jest.mock("axios", () => ({ create: () => ({ get: (...a: unknown[]) => mockGet(...a) }) }));
const mockSetex = jest.fn();
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: (...a: unknown[]) => mockSetex(...a) },
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../rateLimiter", () => ({
    INTERACTIVE_PRIORITY: 10,
    rateLimiter: { execute: (_key: string, fn: () => unknown) => fn() },
}));

import { wikidataService } from "../wikidata";

const MBID = "83d91898-7763-47d7-b03b-b92132375c47";
const sparql = (id: string | null) => ({ data: { results: { bindings: id ? [{ item: { value: `http://www.wikidata.org/entity/${id}` } }] : [] } } });

beforeEach(() => jest.clearAllMocks());

describe("Wikidata lookups", () => {
    it("never puts a value that is not a MusicBrainz id into the query", async () => {
        for (const bad of ["temp-1a2b", "12345", '83d91898" . } ?x ?y ?z { "', ""]) {
            await expect(wikidataService.getArtistInfo("Someone", bad)).resolves.toEqual({});
        }
        expect(mockGet).not.toHaveBeenCalled();
    });

    it("answers null, uncached, when a source fails", async () => {
        mockGet.mockResolvedValueOnce(sparql("Q2306")).mockRejectedValueOnce(Object.assign(new Error("503"), { response: { status: 503 } }));
        await expect(wikidataService.getArtistInfo("Pink Floyd", MBID)).resolves.toBeNull();
        expect(mockSetex).not.toHaveBeenCalled();
    });

    it("caches an artist Wikidata has no entry for", async () => {
        mockGet.mockResolvedValueOnce(sparql(null));
        await expect(wikidataService.getArtistInfo("Nobody", MBID)).resolves.toEqual({});
        expect(mockSetex).toHaveBeenCalledWith(`wikidata:${MBID}`, 2592000, "{}");
    });

    it("treats a missing English article as no summary, not a failure", async () => {
        mockGet
            .mockResolvedValueOnce(sparql("Q1"))
            .mockResolvedValueOnce({ data: { entities: { Q1: { sitelinks: { enwiki: { title: "X" } }, claims: {} } } } })
            .mockRejectedValueOnce(Object.assign(new Error("404"), { response: { status: 404 } }));
        await expect(wikidataService.getArtistInfo("X", MBID)).resolves.toEqual({ summary: undefined, heroUrl: undefined });
    });

    it("takes the preferred image and never a deprecated one", async () => {
        mockGet
            .mockResolvedValueOnce(sparql("Q1"))
            .mockResolvedValueOnce({
                data: {
                    entities: {
                        Q1: {
                            claims: {
                                P18: [
                                    { rank: "deprecated", mainsnak: { datavalue: { value: "Wrong.jpg" } } },
                                    { rank: "normal", mainsnak: { datavalue: { value: "Ok.jpg" } } },
                                    { rank: "preferred", mainsnak: { datavalue: { value: "Best.jpg" } } },
                                ],
                            },
                        },
                    },
                },
            });
        const out = await wikidataService.getArtistInfo("X", MBID);
        expect(out?.heroUrl).toMatch(/Best\.jpg$/);
    });
});
