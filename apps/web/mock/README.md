# Web API mock

Run the in-memory HTTP/WebSocket mock with `pnpm --filter @game/web mock`. It listens on `http://localhost:8787` (override with `MOCK_PORT`). Run the web app separately with `pnpm --filter @game/web dev` (Vite's default port is 5173); the mock supplies signup/login/logout, account export/deletion, and a ticket-authenticated WebSocket lobby with a scripted participant whose presence changes periodically. Data is ephemeral and resets when the mock stops. Set `MOCK_PORT` to change the mock's port.

The web package tests, including mock/API coverage, run with `pnpm --filter @game/web test` (Vitest); the mock does not need to be started separately for those tests.
