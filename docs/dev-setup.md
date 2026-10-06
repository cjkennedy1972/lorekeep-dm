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

Migration files belong in `apps/server/migrations` and use the node-pg-migrate JavaScript migration format. Tests can use `createTestDatabase` from `apps/server/test/helpers/testDb.ts` to get a fresh schema-scoped pool per test file, then call its `close()` in `afterAll`; `withTestDatabase` wraps that lifecycle and always drops the schema. To stop Postgres and remove its local volume:

```sh
docker compose -f infra/docker-compose.yml down -v
```
