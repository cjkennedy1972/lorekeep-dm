# M0 exit-criteria proof report

Base commit: `7f9f99142428b5cea7d5f325c78e4935cd06b855`

The real-server proof suite runs in `tests/e2e` against a fresh disposable PostgreSQL database migrated from the checked-in SQL files. It starts the compiled `apps/server/dist/main.js` as a separate Node process, uses the actual HTTP/WebSocket routes, and drops the database after the run.

## Proof results

| Exit criterion | Command | Result | Remaining gap |
| --- | --- | --- | --- |
| Two verified accounts join one room and each observes synced presence | `DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:5432/lorekeep pnpm --filter e2e exec vitest run --no-file-parallelism presence.spec.ts` | **PASS** — real signup, email verification, login, room invite join, WS tickets, and both clients observed online `PresenceChanged`; each `StateSync` held two seats. | None observed in local run. |
| SIGTERM/restart preserves state and seq and clients reconnect | `DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:5432/lorekeep pnpm --filter e2e exec vitest run --no-file-parallelism restart.spec.ts --testTimeout=20000` | **PASS** — clean SIGTERM, the durable post-shutdown snapshot/sequence was recovered after restart, and a client reconnected and received the same state and sequence in under 3 seconds. | The expected snapshot is read after graceful disconnect; the server's offline-presence transition is therefore included in the durable state. |
| Under-18 refused; no birthdate stored anywhere | `DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:5432/lorekeep pnpm --filter e2e exec vitest run --no-file-parallelism age-gate.spec.ts` | **PASS** — actual endpoint returns 403 `UNDERAGE`, no account row for attempted email; information-schema scan reports no forbidden birthdate/age/guardian/consent columns; JSON row scan across all app tables has no birthdate-like payload. | Scan is over all app base tables in the disposable DB. |
| Account deletion plus sweeper erases test account PII | `DATABASE_URL=postgres://lorekeep:lorekeep@127.0.0.1:5432/lorekeep pnpm --filter e2e exec vitest run --no-file-parallelism deletion.spec.ts` | **PASS** — authenticated delete request, real `runSweep`, account row removal, then table/column/JSON scan found no account id or email references. | Local object store uses an empty temp/default location; this account did not have an export archive. |

## Integration

The four proof tests are executable via `pnpm --filter e2e test`; that command is included in `.github/workflows/ci.yml` after DB migrations and `infra/ci/run-tests.sh` after the server DB suite. The harness requires `DATABASE_URL` and database-creation privileges to create/drop its disposable database.

## Verification notes

- `docker compose -f infra/docker-compose.yml up -d --wait`: **PASS** (Postgres 16 service healthy).
- `DATABASE_URL=... pnpm --filter @game/server migrate:up`: **PASS**.
- `pnpm install --frozen-lockfile`: **PASS** after updating `pnpm-lock.yaml` for e2e dependencies.
- `pnpm --filter @game/server build`: **PASS** after lifecycle edits.
- Full local e2e run: all four real-server/Postgres proof tests **PASS** (presence, restart, age gate, deletion).
- `pnpm lint`: **PASS**.
- `pnpm format:check`: **PASS**.
- `pnpm -r typecheck` (including e2e strict typecheck): **PASS**.
- `DATABASE_URL=... pnpm --filter @game/server test:db`: **PASS** (15 files, 32 tests).
- `DATABASE_URL=... pnpm -r test`: **PASS**, including all four real-server e2e proofs and workspace unit suites. `DATABASE_URL` is required for the e2e project.
- `pnpm -r build`: **PASS**.
- `pnpm --filter @game/web exec playwright test`: **PASS** (10 tests).
- `git diff --check`: **PASS**.
- `pnpm install --lockfile-only --ignore-scripts` followed by `git diff --exit-code -- pnpm-lock.yaml`: **PASS**.
- The DB suite used a fresh disposable database; migrations and 15 files / 32 DB tests passed, then the database was dropped.
- CI on the final M0-27 commit remains to be observed.
- No board status was changed, and no external messages were sent.
