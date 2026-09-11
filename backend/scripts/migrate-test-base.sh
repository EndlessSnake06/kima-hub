#!/bin/bash
# Migrate this checkout's own Jest template base (kima_v1_test) to the current
# schema. CI runs `prisma migrate deploy` against its test DB before Jest; the
# local equivalent needs the name-swap from backend/.env -> kima_v1_test, which
# is what src/__mocks__/test-db-defaults.cjs does for the test run itself.
set -euo pipefail
cd "$(dirname "$0")/.."   # backend/
export DATABASE_URL="$(node scripts/test-base-url.js)"
npx prisma migrate deploy
