# Real-server M0 proof suite

Requires Docker Compose and permission to create/drop a disposable database using `DATABASE_URL`.

```sh
docker compose -f infra/docker-compose.yml up -d --wait
export DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:5432/lorekeep
pnpm --filter @game/server build
pnpm --filter e2e test
```

The suite migrates a uniquely named temporary database, launches the built server as a child process for each scenario, exercises real HTTP/WebSocket interfaces, then drops the database. It is included in `.github/workflows/ci.yml` and `infra/ci/run-tests.sh` after the normal migrations. See [`docs/plan/m0-proof-report.md`](../../docs/plan/m0-proof-report.md) for observed results and any gaps.
