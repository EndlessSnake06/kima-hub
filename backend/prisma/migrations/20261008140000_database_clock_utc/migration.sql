-- Prisma stores and reads timestamp columns as UTC, while SQL's now() writes the session's own time zone. Every
-- session on this database runs in UTC from here, so the two writers and every comparison between them share one clock.
-- A role that does not own the database (an external server) sets the same default for its own sessions instead.
DO $$
BEGIN
    EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
EXCEPTION WHEN insufficient_privilege THEN
    EXECUTE format('ALTER ROLE %I SET timezone TO %L', current_user, 'UTC');
END
$$;
