#!/bin/bash
# Migrate this checkout's Jest template database (kima_v1_test) to the current
# schema. CI runs `prisma migrate deploy` against its test database before Jest;
# locally the database is the one src/__mocks__/test-db-defaults.cjs resolves.
set -euo pipefail
cd "$(dirname "$0")/.."   # backend/
DATABASE_URL="$(node -p 'require("./src/__mocks__/test-db-defaults.cjs").DATABASE_URL_FALLBACK')"
export DATABASE_URL
npx prisma migrate deploy
