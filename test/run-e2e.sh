#!/usr/bin/env bash
# Starts the disposable Postgres/Redis (if not up), applies migrations and runs the E2E suites.
# The test environment is defined here and in test/utils/env.ts; the project's .env is never used.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/docker-compose.test.yml")

export DATABASE_URL="postgresql://postgres:test@localhost:54340/pp_e2e?schema=public"
export DIRECT_URL="$DATABASE_URL"

"${COMPOSE[@]}" up -d --wait

# Migrate from a scratch copy of schema+migrations so the Prisma CLI never sees the project's .env.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/prisma"
cp "$ROOT/prisma/schema.prisma" "$SCRATCH/prisma/"
cp -R "$ROOT/prisma/migrations" "$SCRATCH/prisma/"
(cd "$SCRATCH" && "$ROOT/node_modules/.bin/prisma" migrate deploy --schema prisma/schema.prisma)

# Run from test/ so Nest's ConfigModule does not pick up the project's .env from cwd.
cd "$ROOT/test"
"$ROOT/node_modules/.bin/jest" --config "$ROOT/test/jest-e2e.json" "$@"
