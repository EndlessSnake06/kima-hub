/**
 * stripPunctuation feeds the last-resort MusicBrainz recording search. It used
 * `/[^\w\s]/`, and `\w` is ASCII-only, so a Japanese or Cyrillic title or artist
 * was stripped to "" and the fallback searched for nothing.
 */

jest.mock("../../utils/redis", () => ({ redisClient: { get: jest.fn(), setEx: jest.fn() } }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { musicBrainzService } from "../musicbrainz";

const strip = (s: string) => musicBrainzService.stripPunctuation(s);

describe("musicBrainzService.stripPunctuation", () => {
    it("removes Latin punctuation", () => {
        expect(strip("Do You Realize??")).toBe("Do You Realize");
        expect(strip("Mr. Brightside!")).toBe("Mr Brightside");
    });

    it("keeps letters of non-Latin scripts", () => {
        expect(strip("東京事変")).toBe("東京事変");
        expect(strip("Кино — Группа крови")).toBe("Кино Группа крови");
        expect(strip("방탄소년단!")).toBe("방탄소년단");
    });

    it("keeps combining marks and accents", () => {
        expect(strip("ガラスの少年")).toBe("ガラスの少年");
        expect(strip("Café Tacvba")).toBe("Café Tacvba");
    });

    it("keeps numbers and collapses whitespace", () => {
        expect(strip("  1999 ... (Remix)  ")).toBe("1999 Remix");
    });
});
