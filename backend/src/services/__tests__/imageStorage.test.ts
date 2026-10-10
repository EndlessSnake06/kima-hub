import fs from "fs";
import path from "path";

jest.mock("../../config", () => ({
    config: {
        music: {
            transcodeCachePath: `/tmp/kima-test-cache-${process.pid}/transcode`,
        },
    },
    USER_AGENT: "Kima/test",
}));

import { nativeFileExists } from "../imageStorage";

describe("nativeFileExists", () => {
    const cacheRoot = `/tmp/kima-test-cache-${process.pid}`;
    const coversBase = path.join(cacheRoot, "covers");

    beforeAll(() => {
        fs.mkdirSync(path.join(coversBase, "artists"), { recursive: true });
        fs.mkdirSync(path.join(coversBase, "albums"), { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(cacheRoot, { recursive: true, force: true });
    });

    it("returns true for existing native file", () => {
        const filePath = path.join(coversBase, "artists", "test123.jpg");
        fs.writeFileSync(filePath, "fake image data here!");
        expect(nativeFileExists("native:artists/test123.jpg")).toBe(true);
    });

    it("returns false for missing native file", () => {
        expect(nativeFileExists("native:artists/nonexistent.jpg")).toBe(false);
    });

    it("returns false for non-native paths", () => {
        expect(nativeFileExists("http://example.com/image.jpg")).toBe(false);
    });

    it("returns false for null/empty", () => {
        expect(nativeFileExists(null)).toBe(false);
        expect(nativeFileExists("")).toBe(false);
    });

    it("returns false for path traversal attempts", () => {
        expect(nativeFileExists("native:../../etc/passwd")).toBe(false);
    });
});
