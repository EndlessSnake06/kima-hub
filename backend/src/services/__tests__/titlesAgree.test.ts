/**
 * titlesAgree decides whether a MusicBrainz hit is the album we asked for.
 *
 * It used to fold with /[^a-z0-9]/, so any title with no Latin letters folded
 * to "" and every such pair "agreed": a search hit for "ロンドン" was accepted
 * as the album "東京事変". These tests pin the Unicode-aware fold and the rule
 * that two empty folds never agree.
 *
 * normalizeForSearch is the REAL one from musicbrainz.ts (only redis, the DB
 * and the other network services are mocked), because how it strips edition
 * markers is part of what is being compared.
 */

jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../../utils/redis", () => ({ redisClient: { get: jest.fn(), setEx: jest.fn() } }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../artistSimilarity", () => ({ getSimilarArtists: jest.fn() }));
jest.mock("../wikidata", () => ({ wikidataService: { getArtistInfo: jest.fn() } }));

import { titlesAgree } from "../enrichment";

describe("titlesAgree", () => {
    it("does not match two different Japanese titles", () => {
        expect(titlesAgree("東京事変", "ロンドン")).toBe(false);
        expect(titlesAgree("教育", "大人")).toBe(false);
    });

    it("matches the same Japanese title, including full-width vs half-width forms", () => {
        expect(titlesAgree("東京事変", "東京事変")).toBe(true);
        // NFKC: full-width Latin and half-width katakana fold to the standard forms.
        expect(titlesAgree("ＡＢＣ　ロンドン", "abc ﾛﾝﾄﾞﾝ")).toBe(true);
    });

    it("keeps a dakuten meaningful: カ and ガ are different words", () => {
        expect(titlesAgree("カラス", "ガラス")).toBe(false);
    });

    it("does not match two different Cyrillic titles, but matches across case", () => {
        expect(titlesAgree("Кино", "Звезда")).toBe(false);
        expect(titlesAgree("Группа крови", "ГРУППА КРОВИ!")).toBe(true);
    });

    it("does not match two different Korean titles", () => {
        expect(titlesAgree("방탄소년단", "블랙핑크")).toBe(false);
        expect(titlesAgree("화양연화 pt.1", "화양연화 Pt 1")).toBe(true);
    });

    it("keeps Devanagari vowel signs, which are part of the word", () => {
        // Both are only consonants + matras; dropping marks would make them agree.
        expect(titlesAgree("किताब", "कताब")).toBe(false);
    });

    it("treats a Latin accent as a spelling difference, not a different album", () => {
        expect(titlesAgree("Café Tacvba", "Cafe Tacuba")).toBe(false); // different words
        expect(titlesAgree("Café del Mar", "Cafe del Mar")).toBe(true);
        expect(titlesAgree("Björk", "Bjork")).toBe(true);
        // The old fold turned "Café" into "caf", so "Caf" matched it.
        expect(titlesAgree("Café", "Caf")).toBe(false);
    });

    it("matches a deluxe or remaster against the plain title", () => {
        expect(titlesAgree("Delta Machine (Deluxe Edition)", "Delta Machine")).toBe(true);
        expect(titlesAgree("A Broken Frame - 2006 Remaster", "A Broken Frame")).toBe(true);
        expect(titlesAgree("東京事変 (Deluxe Edition)", "東京事変")).toBe(true);
        expect(titlesAgree("東京事変 (Deluxe Edition)", "ロンドン")).toBe(false);
    });

    it("never lets two titles that fold to nothing agree", () => {
        expect(titlesAgree("!!!", "???")).toBe(false);
        expect(titlesAgree("(Untitled)", "[Bonus]")).toBe(false);
        expect(titlesAgree("", "")).toBe(false);
        expect(titlesAgree("   ", "   ")).toBe(false);
    });

    it("still matches a punctuation-only title against itself", () => {
        expect(titlesAgree("!!!", "!!!")).toBe(true);
    });
});
