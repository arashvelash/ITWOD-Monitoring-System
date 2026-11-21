-- ---------------------------------------------------------------------------
-- Executed once by the official postgres image when the data directory is
-- first initialised (docker-entrypoint-initdb.d). Schema objects themselves are
-- created by Prisma migrations (backend/prisma/migrations).
-- ---------------------------------------------------------------------------

-- Nobody but the owner may create objects in the public schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Sensible defaults for a small management database.
ALTER DATABASE ims SET timezone TO 'UTC';
ALTER DATABASE ims SET statement_timeout TO '60s';
ALTER DATABASE ims SET idle_in_transaction_session_timeout TO '120s';
