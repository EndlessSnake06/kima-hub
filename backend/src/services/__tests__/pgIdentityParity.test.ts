/**
 * Identity keys from the TypeScript must match the `kima_*` SQL functions the
 * migrations use, or a backfilled key is unreachable at runtime. Expectations are
 * generated from the shipped Postgres image by `npm run gen:pg-text-rules`;
 * regenerate after changing those functions, never edit by hand.
 */

import { artistIdentityKey, artistSortName, normalizeArtistName } from "../artistIdentity";
import { albumIdentityKey } from "../albumIdentity";
import golden from "./fixtures/pgIdentityGolden.json";

type Row = {
    in: string;
    identityKey: string;
    normalizedName: string;
    sortName: string;
    albumIdentityKey: string;
};

const rows = golden as Row[];

/** U+XXXX form, so a diff on invisible characters is readable. */
function describeInput(value: string): string {
    if (value === "") return "(empty)";
    return [...value]
        .map((ch) => {
            const cp = ch.codePointAt(0)!;
            return cp < 0x20 || cp === 0x7f || (cp >= 0x80 && !/[\p{L}\p{N}]/u.test(ch))
                ? `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`
                : ch;
        })
        .join("");
}

describe("identity keys match the SQL the migrations run", () => {
    it("has a non-trivial corpus", () => {
        expect(rows.length).toBeGreaterThan(300);
    });

    const check = (
        label: keyof Omit<Row, "in">,
        fn: (v: string) => string
    ) => {
        it(`${label} agrees with Postgres on all ${rows.length} inputs`, () => {
            const mismatches = rows
                .filter((r) => fn(r.in) !== r[label])
                .map((r) => `${describeInput(r.in)}: ts=${JSON.stringify(fn(r.in))} sql=${JSON.stringify(r[label])}`);
            expect(mismatches).toEqual([]);
        });
    };

    check("identityKey", artistIdentityKey);
    check("normalizedName", normalizeArtistName);
    check("sortName", artistSortName);
    check("albumIdentityKey", albumIdentityKey);
});
