/**
 * Regenerates src/services/pgTextRules.ts and its parity fixture from a live
 * Postgres: unaccent(), [:alnum:], lower() and \s across the BMP, none of which
 * match their JavaScript equivalents. Rerun after a Postgres image upgrade:
 * `npm run gen:pg-text-rules` (needs DATABASE_URL and unaccent).
 */
import { readFileSync, writeFileSync } from "fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const RULES_PATH = "src/services/pgTextRules.ts";
const FIXTURE_PATH = "src/services/__tests__/fixtures/pgIdentityGolden.json";

/** Every BMP codepoint except the surrogate range. */
function bmp(): number[] {
    const cps: number[] = [];
    for (let c = 0x80; c < 0x10000; c++) {
        if (c >= 0xd800 && c <= 0xdfff) continue;
        cps.push(c);
    }
    return cps;
}

/** Collapse a sorted codepoint list into inclusive ranges. */
function toRanges(cps: number[]): [number, number][] {
    const out: [number, number][] = [];
    for (const c of cps) {
        const last = out[out.length - 1];
        if (last && c === last[1] + 1) last[1] = c;
        else out.push([c, c]);
    }
    return out;
}

const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, "0");

/** Escape a payload for embedding inside a generated template literal. */
function forTemplate(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "$\\{");
}

async function main() {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    const cps = bmp();

    const unaccentRows = await prisma.$queryRawUnsafe<{ cp: number; folded: string }[]>(
        `SELECT cp, unaccent(chr(cp)) AS folded
         FROM unnest($1::int[]) AS cp
         WHERE unaccent(chr(cp)) IS DISTINCT FROM chr(cp)
         ORDER BY cp`,
        cps
    );

    const alnumRows = await prisma.$queryRawUnsafe<{ cp: number }[]>(
        `SELECT cp FROM unnest($1::int[]) AS cp
         WHERE regexp_replace(chr(cp), '[^[:alnum:]]', '', 'g') <> ''
         ORDER BY cp`,
        cps
    );

    const lowerRows = await prisma.$queryRawUnsafe<{ cp: number; lowered: string }[]>(
        `SELECT cp, lower(chr(cp)) AS lowered
         FROM unnest($1::int[]) AS cp
         WHERE lower(chr(cp)) IS DISTINCT FROM chr(cp)
         ORDER BY cp`,
        cps
    );

    const spaceRows = await prisma.$queryRawUnsafe<{ cp: number }[]>(
        `SELECT cp FROM unnest($1::int[]) AS cp
         WHERE regexp_replace(chr(cp), '\\s', '', 'g') = ''
         ORDER BY cp`,
        cps
    );

    // Postgres lower() only reports what it changes; anything absent is
    // unchanged. Only the codepoints where V8 disagrees need storing.
    const pgLowerMap = new Map(lowerRows.map((r) => [r.cp, r.lowered]));
    const lowerDelta = cps
        .map((cp) => {
            const ch = String.fromCodePoint(cp);
            return { cp, pg: pgLowerMap.get(cp) ?? ch, js: ch.toLowerCase() };
        })
        .filter((r) => r.pg !== r.js)
        .map((r) => [r.cp, r.pg] as [number, string]);

    const alnumRanges = toRanges(alnumRows.map((r) => r.cp));
    const spaceClass = toRanges(spaceRows.map((r) => r.cp))
        .map(([a, b]) => (a === b ? `\\\\u${hex(a)}` : `\\\\u${hex(a)}-\\\\u${hex(b)}`))
        .join("");

    writeFileSync(
        RULES_PATH,
        buildModule({
            unaccent: unaccentRows.map((r) => [r.cp, r.folded] as [number, string]),
            alnumRanges,
            lowerDelta,
            spaceClass,
        }),
        "utf-8"
    );
    console.log(
        `wrote ${RULES_PATH} — ${unaccentRows.length} unaccent entries, ` +
            `${alnumRanges.length} alnum ranges, ${lowerDelta.length} lower delta, ` +
            `${spaceRows.length} non-ASCII space codepoints`
    );

    await regenerateParityFixture();
}

function buildModule(data: {
    unaccent: [number, string][];
    alnumRanges: [number, number][];
    lowerDelta: [number, string][];
    spaceClass: string;
}): string {
    const L: string[] = [];
    const p = (s = "") => L.push(s);

    p("/**");
    p(" * GENERATED -- do not hand-edit. Regenerate with `npm run gen:pg-text-rules`.");
    p(" *");
    p(" * Postgres text semantics the identity keys depend on, swept from the shipped");
    p(" * image: `unaccent()`, `[:alnum:]`, `lower()` and `\\s`. Keys are computed both");
    p(" * here and in SQL backfills, so the two must agree character for character.");
    p(" */");
    p();
    p(`/** codepoint(hex) SP replacement, one per line. ${data.unaccent.length} entries. */`);
    p("const UNACCENT_DATA = `\\");
    p(forTemplate(data.unaccent.map(([cp, v]) => `${hex(cp)} ${v}`).join("\n")) + "`;");
    p();
    p("const UNACCENT = new Map<string, string>();");
    p('for (const line of UNACCENT_DATA.split("\\n")) {');
    p("    if (!line) continue;");
    p('    const sp = line.indexOf(" ");');
    p("    UNACCENT.set(String.fromCodePoint(parseInt(line.slice(0, sp), 16)), line.slice(sp + 1));");
    p("}");
    p();
    p("/**");
    p(" * Postgres `unaccent()`: a per-character substitution, not Unicode");
    p(" * normalisation (it strips a bare combining mark but keeps composed kana).");
    p(" * Iterates by code point so astral characters pass through whole.");
    p(" */");
    p("export function unaccent(value: string): string {");
    p('    let out = "";');
    p("    for (const ch of value) out += UNACCENT.get(ch) ?? ch;");
    p("    return out;");
    p("}");
    p();
    p("/**");
    p(` * Codepoint ranges Postgres \`[:alnum:]\` accepts (${data.alnumRanges.length} ranges). It is not`);
    p(` * JavaScript's \\p{L}\\p{N}: it accepts Hebrew and Arabic combining points and`);
    p(" * rejects superscripts and fractions.");
    p(" */");
    p(
        'const ALNUM_RANGES = "' +
            data.alnumRanges.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join(",") +
            '";'
    );
    p();
    p('const ALNUM: [number, number][] = ALNUM_RANGES.split(",").map((part) => {');
    p('    const dash = part.indexOf("-");');
    p("    if (dash === -1) {");
    p("        const v = parseInt(part, 16);");
    p("        return [v, v] as [number, number];");
    p("    }");
    p("    return [parseInt(part.slice(0, dash), 16), parseInt(part.slice(dash + 1), 16)] as [number, number];");
    p("});");
    p();
    p("/** ASCII is below every swept range, so it is answered without a search. */");
    p("function isAlnumCodePoint(cp: number): boolean {");
    p("    if (cp < 0x80) {");
    p("        return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122);");
    p("    }");
    p("    let lo = 0;");
    p("    let hi = ALNUM.length - 1;");
    p("    while (lo <= hi) {");
    p("        const mid = (lo + hi) >> 1;");
    p("        if (cp < ALNUM[mid][0]) hi = mid - 1;");
    p("        else if (cp > ALNUM[mid][1]) lo = mid + 1;");
    p("        else return true;");
    p("    }");
    p("    return false;");
    p("}");
    p();
    p("/** Drop every character Postgres `[^[:alnum:]]` would drop. */");
    p("export function stripNonAlnum(value: string): string {");
    p('    let out = "";');
    p("    for (const ch of value) {");
    p("        if (isAlnumCodePoint(ch.codePointAt(0)!)) out += ch;");
    p("    }");
    p("    return out;");
    p("}");
    p();
    p("/**");
    p(` * Codepoints where Postgres \`lower()\` disagrees with \`toLowerCase()\` (${data.lowerDelta.length}):`);
    p(" * the image's libc predates the Unicode 14/15 mappings at U+A7Cx-U+A7Dx, and");
    p(" * folds U+0130 to plain \"i\" where JavaScript adds a combining dot.");
    p(" */");
    p("const LOWER_DELTA_DATA = `\\");
    p(forTemplate(data.lowerDelta.map(([cp, v]) => `${hex(cp)} ${v}`).join("\n")) + "`;");
    p();
    p("const LOWER_DELTA = new Map<string, string>();");
    p('for (const line of LOWER_DELTA_DATA.split("\\n")) {');
    p("    if (!line) continue;");
    p('    const sp = line.indexOf(" ");');
    p("    LOWER_DELTA.set(String.fromCodePoint(parseInt(line.slice(0, sp), 16)), line.slice(sp + 1));");
    p("}");
    p();
    p("/** `lower()` as this Postgres implements it, not as V8 does. */");
    p("export function pgLower(value: string): string {");
    p('    let out = "";');
    p("    for (const ch of value) out += LOWER_DELTA.get(ch) ?? ch.toLowerCase();");
    p("    return out;");
    p("}");
    p();
    p("/**");
    p(" * The whitespace set Postgres `\\s` matches. JavaScript also matches U+00A0,");
    p(" * U+2007, U+202F and U+FEFF, and SQL `trim()` strips ASCII spaces only, so the");
    p(" * migrations regex-trim on this class too.");
    p(" */");
    p(`const PG_SPACE = "\\\\t\\\\n\\\\v\\\\f\\\\r ${data.spaceClass}";`);
    p();
    p('const PG_SPACE_RUN = new RegExp(`[${PG_SPACE}]+`, "g");');
    p('const PG_SPACE_TRIM = new RegExp(`^[${PG_SPACE}]+|[${PG_SPACE}]+$`, "g");');
    p();
    p("/** `trim()` as Postgres regex-trims it -- NOT JavaScript's `.trim()`. */");
    p("export function pgTrim(value: string): string {");
    p('    return value.replace(PG_SPACE_TRIM, "");');
    p("}");
    p();
    p("/** Collapse runs of Postgres-whitespace to a single space. */");
    p("export function pgCollapseSpace(value: string): string {");
    p('    return value.replace(PG_SPACE_RUN, " ");');
    p("}");
    p();
    p("/**");
    p(" * Leading articles stripped from sort values; Subsonic's `ignoredArticles` is");
    p(" * built from it and SQL `kima_sort_name` mirrors it. A change needs a migration");
    p(" * replacing that function and re-deriving sortName, then a regenerate. The");
    p(" * parity fixture covers only the, a, an, los and die.");
    p(" */");
    p("export const LEADING_ARTICLES = [");
    p('    "the", "a", "an",');
    p('    "le", "la", "les",');
    p('    "los", "las",');
    p('    "die", "der", "das",');
    p("] as const;");
    p();
    p("/** Leading-article prefix, using the Postgres whitespace class. */");
    p("export const PG_LEADING_ARTICLE = new RegExp(");
    p('    `^(?:${LEADING_ARTICLES.join("|")})[${PG_SPACE}]+`,');
    p('    "i"');
    p(");");
    p();

    return L.join("\n");
}

/**
 * Re-derive the parity fixture from the `kima_*` SQL functions the migrations
 * define. The inputs are kept; only the expectations are recomputed.
 */
async function regenerateParityFixture() {
    let inputs: string[];
    try {
        inputs = (JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as { in: string }[]).map(
            (r) => r.in
        );
    } catch {
        console.warn(`  ${FIXTURE_PATH} not found — skipping fixture regeneration`);
        return;
    }

    const rows = await prisma.$queryRawUnsafe<Record<string, string>[]>(
        `SELECT v AS "in",
                kima_identity_key(v)       AS "identityKey",
                kima_normalized_name(v)    AS "normalizedName",
                kima_sort_name(v)          AS "sortName",
                kima_album_identity_key(v) AS "albumIdentityKey"
         FROM unnest($1::text[]) WITH ORDINALITY AS t(v, ord)
         ORDER BY ord`,
        inputs
    );

    writeFileSync(FIXTURE_PATH, JSON.stringify(rows, null, 1) + "\n", "utf-8");
    console.log(`wrote ${FIXTURE_PATH} (${rows.length} rows)`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
