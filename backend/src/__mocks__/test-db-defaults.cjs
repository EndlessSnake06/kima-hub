/**
 * Local-dev DATABASE_URL/REDIS_URL fallbacks shared by test-env.cjs and
 * test-global-setup.cjs. Credentials come from the gitignored backend/.env,
 * with the database swapped to this checkout's own test database, so tests
 * never reach another checkout's server. CI sets its own URLs.
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
