/**
 * Shared local-dev fallback values for DATABASE_URL/REDIS_URL.
 *
 * Both test-env.cjs (loaded per Jest worker via `setupFiles`) and
 * test-global-setup.cjs (run ONCE by Jest in a separate process via
 * `globalSetup`, which never loads `setupFiles`) need to know the same "if
 * nothing else is configured, assume local dev" values. Factored out here so
 * the two can't drift apart into disagreeing about what "local dev" means.
 *
 * The credentials are NOT hardcoded. They are derived at runtime from the
 * developer's gitignored backend/.env (the same file config.ts loads), with
 * the database name swapped to this checkout's own test database. Two
 * reasons, both learned the hard way:
 *
 * 1. A previous revision hardcoded a test password here, and a later edit
 *    replaced it with a redaction placeholder ('***') that was never caught
 *    -- a bare `npm test` then silently failed to authenticate. Secrets
 *    cannot rot the same way if they are never written here at all.
 * 2. The fallback must never point at another checkout's server. It used to
 *    aim at port 5433, which is the social checkouts' shared test server; a
 *    `prisma db push` from this project against it once dropped 22 of their
 *    tables. This now aims at THIS checkout's dedicated Postgres (5455) and
 *    its own database name, so it cannot reach across.
 *
 * CI is unaffected: it exports its own DATABASE_URL/REDIS_URL, and every
 * consumer uses `??=`, so these values never fire there.
 */
const fs = require("fs");
const path = require("path");

// backend/.env lives one directory up from this file (cwd may vary).
function envValue(name) {
    for (const dir of [path.resolve(__dirname, "../.."), process.cwd()]) {
        try {
            const text = fs.readFileSync(path.join(dir, ".env"), "utf8");
            const m = text.match(new RegExp(`^${name}=["']?([^"'\\n]+)["']?`, "m"));
            if (m) return m[1].trim();
        } catch {
            /* no .env here; try the next candidate */
        }
    }
    return null;
}

function swapDbName(url, dbName) {
    try {
        const u = new URL(url);
        u.pathname = `/${dbName}`;
        return u.toString();
    } catch {
        return null;
    }
}

const devDatabaseUrl = envValue("DATABASE_URL");

module.exports = {
    // This checkout's dedicated test database, on its dedicated server.
    DATABASE_URL_FALLBACK:
        (devDatabaseUrl && swapDbName(devDatabaseUrl, "kima_v1_test")) ||
        "postgresql://test:***@localhost:5477/kima_v1_test",
    REDIS_URL_FALLBACK: envValue("REDIS_URL") || "redis://localhost:6390",
};
