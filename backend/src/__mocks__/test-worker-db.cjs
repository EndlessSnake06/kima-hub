/**
 * Per-worker database naming, shared by test-env.cjs (points a worker at its
 * database) and test-global-setup.cjs (creates them). Worker ids run 1..N.
 */

/** The bare database name a Postgres connection URL points at. */
function databaseNameOf(url) {
    return new URL(url).pathname.replace(/^\//, "");
}

/** worker id 1 => "<base>_w1", etc. */
function workerDatabaseName(baseUrl, workerId) {
    return `${databaseNameOf(baseUrl)}_w${workerId}`;
}

/** Same connection (host/port/user/pass/query params) as `baseUrl`, pointed at that worker's own database instead of the shared one. */
function workerDatabaseUrl(baseUrl, workerId) {
    const u = new URL(baseUrl);
    u.pathname = `/${workerDatabaseName(baseUrl, workerId)}`;
    return u.toString();
}

/** Same connection as `baseUrl`, pointed at Postgres's own always-present admin database -- never the template db itself, which Postgres refuses to clone FROM while anything (including the cloning connection) is connected TO it. */
function adminDatabaseUrl(baseUrl) {
    const u = new URL(baseUrl);
    u.pathname = "/postgres";
    return u.toString();
}

module.exports = { databaseNameOf, workerDatabaseName, workerDatabaseUrl, adminDatabaseUrl };
