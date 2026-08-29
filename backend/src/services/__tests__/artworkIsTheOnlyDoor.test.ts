/**
 * Artwork has one door, and this test is what keeps it that way.
 *
 * Before `artwork.ts`, fifteen places in this backend went looking for a
 * picture and twelve of them asked a single provider and gave up. Deezer alone
 * in nine places, the Cover Art Archive alone in three, and two routes that
 * asked nobody -- they built `coverartarchive.org/release-group/<mbid>
 * /front-500` as a string and handed it to the browser, which took the 404 in
 * silence because that request never reached this server.
 *
 * That did not happen because anyone decided it should. It happened one call
 * site at a time, each one reasonable on its own, until "why is there a
 * placeholder here" had six different answers. Nothing in the type system
 * stops the sixteenth.
 *
 * So this is the rule, enforced rather than written down: only `artwork.ts`
 * calls an artwork source, and nobody builds a Cover Art Archive address by
 * hand. If you are adding a provider, add it to the list in `artwork.ts` --
 * that is the whole point of the list.
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

    it("the Last.fm grey-star placeholder is filtered in exactly one place", () => {
        // Five call sites used to carry their own copy of this hash, and one
        // of them forgot, which is how grey stars reached artist pages.
        const withHash = sourceFiles(SRC)
            .filter((f) => read(f).includes("2a96cbd8b46e442fc41c2b86b821562f"))
            .map(relative);

        expect(withHash).toEqual(["services/lastfm.ts"]);
    });
});
