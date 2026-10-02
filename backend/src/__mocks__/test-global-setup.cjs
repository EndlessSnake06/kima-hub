/**
 * Runs once before any worker. Clones one database per Jest worker
 * (`<base>_w<id>`, 1..maxWorkers) from the migrated base and wipes each to
 * zero rows every run. Files on different workers cannot touch each other's
 * rows; shared-database parallel runs failed with unexplained FK violations.
 */
const { DATABASE_URL_FALLBACK } = require('./test-db-defaults.cjs');
const { databaseNameOf, workerDatabaseName, workerDatabaseUrl, adminDatabaseUrl } = require('./test-worker-db.cjs');

/** The most recently applied migration's name, or null on a database with no `_prisma_migrations` table yet. */
async function latestMigration(client) {
    try {
        const rows =
            await client.$queryRaw`SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 1`;
        return rows[0]?.migration_name ?? null;
    } catch {
        return null;
    }
}

/**
 * Truncates every table in the public schema, found from `pg_tables` so new
 * models are covered. `_prisma_migrations` is kept so the database still
 * reads as migrated.
 */
async function wipeAllRows(client) {
    await client.$executeRawUnsafe(`
        DO $$
        DECLARE tbls text;
        BEGIN
            SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
              INTO tbls
              FROM pg_tables
             WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';
            IF tbls IS NOT NULL THEN
                EXECUTE 'TRUNCATE TABLE ' || tbls || ' CASCADE';
            END IF;
        END $$;
    `);
}

/** Connect to `url`, run `fn`, always disconnect -- the shape every per-worker probe/wipe below shares. */
async function withClient(PrismaClient, url, fn) {
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
        return await fn(client);
    } finally {
        await client.$disconnect();
    }
}

module.exports = async function globalSetup(globalConfig) {
    process.env.DATABASE_URL ??= DATABASE_URL_FALLBACK;
    const baseUrl = process.env.DATABASE_URL;

    // Required so late so @prisma/client reads the DATABASE_URL set above --
    // requiring it any earlier would read process.env before the fallback runs.
    const { PrismaClient } = require('@prisma/client');

    // The base database is the template every worker database is cloned from,
    // so it must already be migrated.
    const base = new PrismaClient();
    let targetMigration;
    try {
        await base.$queryRaw`SELECT 1`; // fail loudly without a real DB
        targetMigration = await latestMigration(base);
    } finally {
        await base.$disconnect(); // Postgres refuses to CREATE DATABASE ... TEMPLATE while anything is connected to the template, including this process
    }

    const baseDbName = databaseNameOf(baseUrl);
    const workerIds = Array.from({ length: globalConfig.maxWorkers }, (_, i) => i + 1);
    const admin = new PrismaClient({ datasources: { db: { url: adminDatabaseUrl(baseUrl) } } });
    try {
        // One query for every worker's existence, not one query PER worker.
        const allDbs = await admin.$queryRaw`SELECT datname FROM pg_database`;
        const existingNames = new Set(allDbs.map((r) => r.datname));

        // Freshness probes are independent reads, so they run concurrently.
        const freshness = await Promise.all(
            workerIds.map(async (workerId) => {
                const dbName = workerDatabaseName(baseUrl, workerId);
                if (!existingNames.has(dbName)) return { workerId, dbName, needsCreate: true, stale: false };
                const theirMigration = await withClient(PrismaClient, workerDatabaseUrl(baseUrl, workerId), latestMigration);
                return { workerId, dbName, needsCreate: false, stale: theirMigration !== targetMigration };
            }),
        );

        // CREATE/DROP DATABASE run one at a time on the shared admin connection.
        for (const { dbName, needsCreate, stale } of freshness) {
            if (needsCreate) {
                await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${baseDbName}"`);
            } else if (stale) {
                // Worker databases are reused across runs; one that predates
                // the base's latest migration is dropped and re-cloned.
                await admin.$executeRawUnsafe(`DROP DATABASE "${dbName}"`);
                await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${baseDbName}"`);
            }
        }
    } finally {
        await admin.$disconnect();
    }

    // Wipe every worker database, new or reused, so no run inherits rows a
    // past run left behind.
    await Promise.all(
        workerIds.map((workerId) => withClient(PrismaClient, workerDatabaseUrl(baseUrl, workerId), wipeAllRows)),
    );
};
