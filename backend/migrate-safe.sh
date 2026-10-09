#!/bin/sh
set -e

echo "[MIGRATE] Starting safe migration process..."

if DEPLOY_RESULT=$(npx prisma migrate deploy 2>&1); then
  echo "$DEPLOY_RESULT" | tail -3
  echo "[MIGRATE] ✓ Database is up to date"
  exit 0
fi

# P3005: the database has tables but no migration history (an install from
# before migrations were tracked). Mark every migration applied, then deploy
# anything newer.
if echo "$DEPLOY_RESULT" | grep -q "P3005"; then
  echo "[MIGRATE] Database exists without migration history (P3005); baselining..."
  BASELINE_COUNT=0
  for migration_dir in prisma/migrations/*/; do
    [ -d "$migration_dir" ] || continue
    migration_name=$(basename "$migration_dir")
    echo "  ✓ Marking as applied: $migration_name"
    npx prisma migrate resolve --applied "$migration_name" >/dev/null 2>&1 || true
    BASELINE_COUNT=$((BASELINE_COUNT + 1))
  done
  echo "[MIGRATE] ✓ Baselined $BASELINE_COUNT migrations"

  if DEPLOY_RESULT=$(npx prisma migrate deploy 2>&1); then
    echo "$DEPLOY_RESULT" | tail -3
    echo "[MIGRATE] ✓ Database is up to date"
    exit 0
  fi
fi

# Starting on a half-migrated database corrupts data; stop here instead.
echo "[MIGRATE] ✗ Migration failed:"
echo "$DEPLOY_RESULT" | tail -20
exit 1
