# Lorekeep-DM

A web-based, AI-driven tabletop RPG game master for groups of 1–6 players. A deterministic rules engine owns dice and state; the LLM narrates and proposes typed actions.

**Status:** design phase. See [docs/spec.md](docs/spec.md), [docs/architecture.md](docs/architecture.md), [docs/adr/](docs/adr/), [docs/research.md](docs/research.md), [docs/reuse-audit.md](docs/reuse-audit.md).

## Attribution

This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

Lorekeep-DM is not affiliated with or endorsed by Wizards of the Coast.

## License

Code is released under the [MIT License](LICENSE). SRD-derived content remains under CC-BY-4.0 as noted above.

## Repository layout

- `apps/server` — Fastify and WebSocket service (`@game/server`)
- `apps/web` — React and Vite browser app (`@game/web`)
- `packages/schema` — shared contracts (`@game/schema`)
- `packages/engine` — deterministic rules engine (`@game/rules-engine`)
- `infra` — Docker Compose and CI helpers
- `tests/e2e` — cross-app proofs
- `docs` — architecture and plans

Apps may depend on packages; packages never depend on apps. The web app never imports the server.
