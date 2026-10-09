# Local development setup

Requirements: Docker with Compose and pnpm 12.9.1 (Node.js 26).

Start the local Postgres 16 instance with one command:

```sh
docker compose -f infra/docker-compose.yml up -d --wait
```

The default connection string is `postgres://lorekeep:lorekeep@localhost:5432/lorekeep`. Copy `.env.example` to `.env` if you want to load it into your shell; `DATABASE_URL` is the only database environment variable required by the server, migration runner, and test database helper.

Run migrations from the repository root:

```sh
pnpm --filter @game/server migrate:up
pnpm --filter @game/server migrate:down
```

`migrate:up`, `migrate:down`, and `migrate:up` again run cleanly on an empty database. The Postgres container is shared by every checkout that uses this compose file, and `test:db` suites delete rows such as `operator_endpoints`; when you run a live server while other tests may be running, create a private database (`docker exec infra-postgres-1 psql -U lorekeep -c 'create database lorekeep_mine'`) and point `DATABASE_URL` at it.

Migration files belong in `apps/server/migrations` and use the node-pg-migrate JavaScript migration format. Run unit tests (no database required) with `pnpm --filter @game/server test`. Database-backed migration tests are separate: start Postgres, export `DATABASE_URL`, then run `pnpm --filter @game/server test:db`. The `test:db` command fails immediately if `DATABASE_URL` is unset.

Tests can use `createTestDatabase` from `apps/server/test/db/testDb.ts` to get a fresh schema-scoped pool per test file, then call its `close()` in `afterAll`; `withTestDatabase` wraps that lifecycle and always drops the schema. To stop Postgres and remove its local volume:

```sh
docker compose -f infra/docker-compose.yml down -v
```


### Database-backed tests

All Postgres-backed server tests belong in `apps/server/test/db/`. They are intentionally excluded from `pnpm --filter @game/server test` and run only with `pnpm --filter @game/server test:db`, which requires `DATABASE_URL` and fails if it is unset. Start the development database with `docker compose -f infra/docker-compose.yml up -d --wait`, apply migrations with `pnpm --filter @game/server migrate:up`, then run the DB suite.

## Database credentials and exposure

`infra/docker-compose.yml` publishes Postgres on `127.0.0.1` only and uses the public default `lorekeep` credentials; it is for local development. Any real deployment must use non-default, secret credentials and a least-privilege application role (DML on application tables only; migrations run under a separate owner role). Never publish the database port on a reachable interface. CI uses a service container and is unaffected.

## Browser e2e against the real server

`apps/web/playwright.live.config.ts` runs a keyboard-only game-screen test against the real server (Room, Postgres, a scripted recorded-style DM, no network). It starts the server through `apps/server/vitest.live.config.ts` (seeds an adult account and a pre-combat table, writes the session token to `apps/web/test-results/live-state.json`) and Vite on port 5174 with a same-origin proxy to the server on 8799 (the server compares `Origin` with `Host`, so the proxy must not change the host).

```
docker exec infra-postgres-1 psql -U lorekeep -d postgres -c 'CREATE DATABASE lorekeep_e2e'   # private DB; the compose database is shared
export DATABASE_URL=postgres://lorekeep:lorekeep@localhost:5432/lorekeep_e2e
pnpm build && pnpm --filter @game/server migrate:up
pnpm --filter @game/web exec playwright test -c playwright.live.config.ts
```

## LLM endpoints and recorded replay

Tests and local development need no LLM key: the server test suite and the golden-scenario tests run without network access.

```sh
pnpm --filter @game/server test
pnpm --filter @game/e2e exec vitest run m2-scenarios
```

To point a local server at a model, see [the operator guide](operator-guide.md): endpoint slots are saved through `/api/operator/endpoints/:slot`, plain-HTTP or loopback model hosts need `LLM_ALLOW_LOCAL_HOSTS`, and `LLM_FIXTURE_MODE` (`strict`, `lenient`, `record`) selects recorded-LLM replay. Set `OPERATOR_EMAILS` to your account email to use the operator routes. Never commit a real API key or a recorded fixture you have not reviewed.
