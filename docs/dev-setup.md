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

Migration files belong in `apps/server/migrations` and use the node-pg-migrate JavaScript migration format. Run unit tests (no database required) with `pnpm --filter @game/server test`. Database-backed migration tests are separate: start Postgres, export `DATABASE_URL`, then run `pnpm --filter @game/server test:db`. The `test:db` command fails immediately if `DATABASE_URL` is unset.

Tests can use `createTestDatabase` from `apps/server/test/db/testDb.ts` to get a fresh schema-scoped pool per test file, then call its `close()` in `afterAll`; `withTestDatabase` wraps that lifecycle and always drops the schema. To stop Postgres and remove its local volume:

```sh
docker compose -f infra/docker-compose.yml down -v
```


### Database-backed tests

All Postgres-backed server tests belong in `apps/server/test/db/`. They are intentionally excluded from `pnpm --filter @game/server test` and run only with `pnpm --filter @game/server test:db`, which requires `DATABASE_URL` and fails if it is unset. Start the development database with `docker compose -f infra/docker-compose.yml up -d --wait`, apply migrations with `pnpm --filter @game/server migrate:up`, then run the DB suite.

## Database credentials and exposure

`infra/docker-compose.yml` publishes Postgres on `127.0.0.1` only and uses the public default `lorekeep` credentials; it is for local development. Any real deployment must use non-default, secret credentials and a least-privilege application role (DML on application tables only; migrations run under a separate owner role). Never publish the database port on a reachable interface. CI uses a service container and is unaffected.
