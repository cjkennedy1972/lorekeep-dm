import type { DMTurnEvent } from '@game/schema';
import type { ToolExecutorState } from '@game/rules-engine/room-tools';
import { execute, loadCatalog } from '@game/rules-engine/room-tools';
import type { Pool } from 'pg';
import {
  runTurn,
  type DmToolContext,
  type TurnResult,
} from '../dm/orchestrator.js';
import { rulesLookup } from '../dm/rulesLookup.js';
import {
  createConfiguredAdapter,
  createEndpointEgress,
} from '../llm/config.js';
import {
  fixtureModeFromEnvironment,
  RecordedLlmAdapter,
} from '../llm/recorded.js';
import type { SoloTurnRequest, SoloTurnRunner } from './dmTurn.js';

type GameState = {
  characters?: Record<string, ToolExecutorState['actors'][string]>;
  gameEngine?: Record<string, unknown>;
  premise?: string;
  sceneId?: string;
  sceneSummary?: string;
};
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class ProductionSoloTurnRunner implements SoloTurnRunner {
  private readonly catalog = loadCatalog();
  private readonly egress = createEndpointEgress();

  constructor(
    private readonly db: Pick<Pool, 'query'>,
    private readonly endpointMasterKey?: string,
    private readonly fixtureMode = fixtureModeFromEnvironment(),
    private readonly fixturePath = process.env.LLM_FIXTURE_PATH ??
      'fixtures/solo-turn.ndjson',
  ) {}

  async run(
    request: SoloTurnRequest,
    onEvent: Parameters<SoloTurnRunner['run']>[1],
  ): Promise<TurnResult> {
    const endpoint = await createConfiguredAdapter(
      this.db,
      'moderate',
      this.egress,
      this.endpointMasterKey,
    );
    const table = await this.db.query<{ name: string }>(
      "SELECT name FROM sessions WHERE id=$1 AND status='active'",
      [request.sessionId],
    );
    if (!table.rows[0]) throw new Error('Table state unavailable');
    const state = asRecord(request.state) as GameState;
    const actors = state.characters ?? {};
    if (Object.keys(actors).length && !actors[request.accountId])
      throw new Error('Player character is not configured for this table');

    const adapter = new RecordedLlmAdapter({
      mode: this.fixtureMode,
      fixturePath: this.fixturePath,
      header: {
        suite: 'solo-turn',
        turn: request.actionId,
        toolMode: 'native',
        model: 'operator-configured',
        catalogVersion: this.catalog.catalogVersion,
        turnSeed: process.env.LLM_FIXTURE_MODE
          ? '0x0000000000000000'
          : 'random',
        endpointProfile: 'moderate',
      },
      upstream: this.fixtureMode === 'record' ? endpoint : undefined,
      allowRecord: process.env.NODE_ENV === 'test',
      environment: process.env.NODE_ENV,
      prefix: 'Lorekeep solo turn',
    });
    const engineState = (state.gameEngine ?? {
      actors,
      attacks: {},
      hp: Object.fromEntries(
        Object.values(actors).map((actor) => [actor.id, actor.hp.current]),
      ),
      ac: {},
      conditions: {},
      catalog: this.catalog,
    }) as unknown as ToolExecutorState;
    const context: DmToolContext = {
      seed: 0,
      rollIndex: 0,
      turnId: request.actionId,
      state,
      engineState,
      commitState(previous, output) {
        return {
          ...(previous as GameState),
          gameEngine: output.nextState,
          characters: (output.nextState as ToolExecutorState).actors,
        };
      },
      engineExecute(prior, call, seed) {
        const current = prior as ToolExecutorState;
        const result = execute(current, call, seed);
        if (!result.ok) return { ...result, events: [] };
        const value = result.value as
          | { events?: readonly unknown[] }
          | undefined;
        return {
          ok: true,
          summary: result.summary,
          events: result.events,
          value: {
            events: value?.events ?? [],
            state: { ...current, ...(value ?? {}) },
          },
        };
      },
      rulesLookup: (topic) => rulesLookup(this.db as Pool, topic),
    };

    return runTurn({
      turnId: request.actionId,
      testMode: process.env.NODE_ENV === 'test',
      ...(process.env.LLM_FIXTURE_MODE ? { turnSeed: 0, testMode: true } : {}),
      prompt: {
        catalogVersion: this.catalog.catalogVersion,
        toolMode: 'native',
        sceneId: state.sceneId ?? request.sessionId,
        settingsHash: 'default',
        session: {
          contentTier: 'standard',
          safetySettings: {},
          partyRoster: Object.values(actors).map((actor) => ({
            id: actor.id,
            name: actor.name,
          })),
          premise:
            state.premise ?? `A solo adventure at ${table.rows[0].name}.`,
          sceneSummary:
            state.sceneSummary ??
            'The party is at the beginning of its adventure.',
        },
        activeMode: 'exploration',
        turn: {
          state: { characters: Object.values(actors) },
          playerText: `${request.playerName ?? 'Player'}: ${request.text}`,
          turns: [],
        },
      },
      context,
      adapter,
      toolMode: 'native',
      emit: (event) => onEvent(event as DMTurnEvent),
    });
  }
}
