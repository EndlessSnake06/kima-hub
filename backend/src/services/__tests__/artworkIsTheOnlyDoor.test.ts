/**
 * Only `artwork.ts` calls an artwork source, and nothing builds a Cover Art
 * Archive address by hand. New providers go in the list in `artwork.ts`.
 */

import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

/** The door itself, and the source implementations it is allowed to call. */
const ALLOWED = new Set(
    ["services/artwork.ts", "services/coverArt.ts", "services/deezer.ts", "services/fanart.ts"].map(
        (p) => path.join(SRC, p),
    ),
);

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === "__tests__" || entry.name === "node_modules"
                ? []
                : sourceFiles(full);
        }
        return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
    });
}

const files = sourceFiles(SRC).filter((f) => !ALLOWED.has(f));
const read = (f: string) => fs.readFileSync(f, "utf8");
const relative = (f: string) => path.relative(SRC, f);

describe("artwork has one door", () => {
    it("nobody calls an artwork source except artwork.ts", () => {
        // deezerService is also a music catalogue -- previews, playlists,
        // podcasts, radio -- so only its two image methods are off limits.
        const offLimits =
            /\b(coverArtService\.getCoverArt|deezerService\.getAlbumCover|deezerService\.getArtistImage|fanartService\.getAlbumCover|fanartService\.getArtistImage)\s*\(/;

        const offenders = files
            .filter((f) => offLimits.test(read(f)))
            .map(relative);

        expect(offenders).toEqual([]);
    });

    it("nobody builds a Cover Art Archive address by hand", () => {
        // The exact shape of the original bug: a URL assembled from an MBID and
        // sent out without anyone asking whether the picture was there.
        const guessed = /["'`]https?:\/\/coverartarchive\.org\//;

        const offenders = files.filter((f) => guessed.test(read(f))).map(relative);

        expect(offenders).toEqual([]);
    });

    it("the grey-star placeholder hash is gone with the service that used it", () => {
        // Five call sites used to carry their own copy of this hash, and one
        // of them forgot, which is how grey stars reached artist pages. The
        // service that owned the filter is deleted; nobody should cite it.
        const withHash = sourceFiles(SRC)
            .filter((f) => read(f).includes("2a96cbd8b46e442fc41c2b86b821562f"))
            .map(relative);

        expect(withHash).toEqual([]);
    });
});
