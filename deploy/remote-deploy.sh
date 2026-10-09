#!/usr/bin/env bash
# Se ejecuta en el VPS (lo copia deploy.yml a $APP_DIR). Recibe el token de GHCR por stdin.
# Requiere: REGISTRY_USER, IMAGE_API, IMAGE_MIGRATE, IMAGE_TAG y opcionalmente APP_DIR.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/picopala}"
: "${REGISTRY_USER:?REGISTRY_USER is required}"
: "${IMAGE_API:?IMAGE_API is required}"
: "${IMAGE_MIGRATE:?IMAGE_MIGRATE is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"

cd "$APP_DIR"
[ -f .env ] || { echo ".env not found in $APP_DIR" >&2; exit 1; }

docker login ghcr.io -u "$REGISTRY_USER" --password-stdin
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

export IMAGE_API IMAGE_MIGRATE IMAGE_TAG
COMPOSE=(docker compose -f docker-compose.prod.yml)

"${COMPOSE[@]}" pull api migrate
"${COMPOSE[@]}" up -d --remove-orphans
