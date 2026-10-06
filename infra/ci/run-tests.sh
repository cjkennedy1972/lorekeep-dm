#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (start infra/docker-compose.yml and export the connection string)}"

pnpm install --frozen-lockfile
pnpm --filter @game/schema build
pnpm -r typecheck
pnpm lint
pnpm format:check
pnpm -r test
pnpm --filter @game/server migrate:up
pnpm --filter @game/server test:db
pnpm -r build
pnpm install --lockfile-only --ignore-scripts
git diff --exit-code -- pnpm-lock.yaml
pnpm --filter @game/web exec playwright install --with-deps chromium
pnpm --filter @game/web exec playwright test
