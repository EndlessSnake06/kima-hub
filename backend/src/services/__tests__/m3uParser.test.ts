import { parseM3U } from "../m3uParser";

describe("M3U Parser", () => {
    it("parses basic M3U (paths only, no metadata)", () => {
        const content = `/music/Artist/Album/01 - Track.flac
/music/Artist/Album/02 - Song.mp3`;

        const entries = parseM3U(content);
        expect(entries).toHaveLength(2);
        expect(entries[0].filePath).toBe("/music/Artist/Album/01 - Track.flac");
        expect(entries[0].artist).toBeNull();
        expect(entries[0].title).toBeNull();
    });

    it("parses extended M3U with EXTINF metadata", () => {
        const content = `#EXTM3U
#EXTINF:213,Alice in Chains - Rotten Apple
/music/Alice in Chains/Jar of Flies/04 - Rotten Apple.flac
#EXTINF:185,Tool - Lateralus
/music/Tool/Lateralus/09 - Lateralus.flac`;

        const entries = parseM3U(content);
        expect(entries).toHaveLength(2);
        expect(entries[0].artist).toBe("Alice in Chains");
        expect(entries[0].title).toBe("Rotten Apple");
        expect(entries[0].durationSeconds).toBe(213);
        expect(entries[0].filePath).toBe(
            "/music/Alice in Chains/Jar of Flies/04 - Rotten Apple.flac",
        );
    });

    it("handles Windows backslash paths", () => {
        const content = `#EXTM3U
#EXTINF:200,Artist - Title
C:\\Music\\Artist\\Album\\01 - Title.mp3`;

        const entries = parseM3U(content);
        expect(entries[0].filePath).toBe("C:/Music/Artist/Album/01 - Title.mp3");
    });

    it("skips empty lines and unknown directives", () => {
        const content = `#EXTM3U
#EXTGRP:Rock

#EXTINF:100,Band - Song
/music/song.flac

`;
        const entries = parseM3U(content);
        expect(entries).toHaveLength(1);
    });

    it("handles EXTINF with no artist separator (title only)", () => {
        const content = `#EXTM3U
#EXTINF:180,Just A Title
/music/file.mp3`;

        const entries = parseM3U(content);
        expect(entries[0].artist).toBeNull();
        expect(entries[0].title).toBe("Just A Title");
    });

    it("rejects files exceeding max entry limit", () => {
        const lines = Array.from(
            { length: 10001 },
            (_, i) => `/music/track${i}.mp3`,
        ).join("\n");
        expect(() => parseM3U(lines, { maxEntries: 10000 })).toThrow(
            "exceeds maximum",
        );
    });

    it("rejects content with null bytes", () => {
        const content = `/music/track\x00.mp3`;
        expect(() => parseM3U(content)).toThrow("null bytes");
    });
});
