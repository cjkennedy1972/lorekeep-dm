import type { DMTurnEvent } from '@game/schema';
import type { RegistryEvent } from '../dm/memory.js';
import { RegistryMemory } from '../dm/memory.js';
import { closeScene } from '../dm/summarize.js';
import { MeteredLlmAdapter, PostgresUsageSink } from '../llm/metering.js';
// Node-only subpath: it pulls in the catalog loader (node:fs), so it must never be reachable
// from the browser-safe engine index (see test/purity.test.ts).
import type {
  ToolExecutorState,
  WorldRegistry,
} from '@game/rules-engine/room-tools';
import {
  execute,
  loadCatalog,
  setFlag,
  logRuling,
  updateQuest,
  upsertLocation,
  upsertNpc,
} from '@game/rules-engine/room-tools';
import type { Pool } from 'pg';
import {
  runTurn,
  type DmToolContext,
  type TurnResult,
} from '../dm/orchestrator.js';
import { rulesLookup } from '../dm/rulesLookup.js';
import { catalogFromSnapshot } from './catalogSnapshot.js';
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
  adventureId?: string;
  catalogVersion?: string;
  difficulty?: string;
  lastNarration?: string;
  lastPlayerText?: string;
  world?: WorldRegistry;
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
    const endpointSlot = process.env.SOLO_TURN_ENDPOINT_SLOT ?? 'moderate';
    if (!['fast', 'frontier', 'moderate'].includes(endpointSlot))
      throw new Error('Solo turn endpoint slot is invalid');
    const endpoint = await createConfiguredAdapter(
      this.db,
      endpointSlot as 'fast' | 'frontier' | 'moderate',
      this.egress,
      this.endpointMasterKey,
    );
    const table = await this.db.query<{
      name: string;
      catalog_version: string | null;
      premise: string | null;
      adventure_id: string | null;
      character: Record<string, unknown> | null;
      catalog_snapshot: unknown;
    }>(
      `SELECT s.name,s.catalog_version,pinned_catalog.entries AS catalog_snapshot,s.premise,s.adventure_id,s.character
       FROM sessions s LEFT JOIN catalog_snapshots pinned_catalog ON pinned_catalog.catalog_version=s.catalog_version
       WHERE s.id=$1 AND s.status='active'`,
      [request.sessionId],
    );
    if (!table.rows[0]) throw new Error('Table state unavailable');
    const catalog =
      table.rows[0].catalog_version === this.catalog.catalogVersion
        ? this.catalog
        : catalogFromSnapshot(
            table.rows[0].catalog_version,
            table.rows[0].catalog_snapshot,
          );
    if (!catalog) throw new Error('Pinned catalog version unavailable');
    const state = asRecord(request.state) as GameState;
    const savedCharacter = table.rows[0].character as unknown as
      | ToolExecutorState['actors'][string]
      | null;
    if (savedCharacter && !state.characters)
      state.characters = { [request.accountId]: savedCharacter };
    if (!state.premise) state.premise = table.rows[0].premise ?? undefined;
    const actors = state.characters ?? {};
    if (Object.keys(actors).length && !actors[request.accountId])
      throw new Error('Player character is not configured for this table');

    const recorded = new RecordedLlmAdapter({
      mode: this.fixtureMode,
      fixturePath: this.fixturePath,
      header: {
        suite: 'solo-turn',
        turn: request.actionId,
        toolMode: 'native',
        model: 'operator-configured',
        catalogVersion: state.catalogVersion ?? catalog.catalogVersion,
        turnSeed: process.env.LLM_FIXTURE_MODE
          ? '0x0000000000000000'
          : 'random',
        endpointProfile: endpointSlot,
      },
      upstream: this.fixtureMode === 'record' ? endpoint : undefined,
      allowRecord: process.env.NODE_ENV === 'test',
      environment: process.env.NODE_ENV,
      prefix: 'Lorekeep solo turn',
    });
    const adapter = new MeteredLlmAdapter(
      recorded,
      new PostgresUsageSink(this.db),
      {
        sessionId: request.sessionId,
        turnId: request.actionId,
        purpose: 'narration',
        modelId: endpointSlot,
      },
    );
    const memory = new RegistryMemory(this.db as Pool);
    const registryEvents: RegistryEvent[] = [];
    const memoryContext = await memory.contextFor(
      request.sessionId,
      request.text,
      state.lastNarration ?? '',
    );
    const engineState = (state.gameEngine
      ? { ...state.gameEngine, catalog }
      : {
          actors,
          attacks: {},
          hp: Object.fromEntries(
            Object.values(actors).map((actor) => [actor.id, actor.hp.current]),
          ),
          ac: {},
          conditions: {},
          catalog,
          world: state.world ?? {
            npcs: {},
            locations: {},
            quests: {},
            flags: {},
            rulings: [],
          },
        }) as unknown as ToolExecutorState & { world: WorldRegistry };
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
          world:
            (output.nextState as { world?: WorldRegistry }).world ??
            (previous as GameState).world,
        };
      },
      engineExecute(prior, call, seed) {
        const current = prior as ToolExecutorState & { world: WorldRegistry };
        const request = call as { name?: string; args?: unknown };
        const worldExecutors = {
          upsert_npc: upsertNpc,
          upsert_location: upsertLocation,
          update_quest: updateQuest,
          set_flag: setFlag,
          log_ruling: logRuling,
        } as const;
        const worldExecute = request.name
          ? worldExecutors[request.name as keyof typeof worldExecutors]
          : undefined;
        const result = worldExecute
          ? worldExecute(current.world, request.args)
          : execute(current, call, seed);
        if (!result.ok) return { ...result, events: [] };
        const value = result.value as
          | { events?: readonly unknown[] }
          | undefined;
        for (const event of value?.events ?? []) {
          if (
            event &&
            typeof event === 'object' &&
            [
              'NpcUpserted',
              'LocationUpserted',
              'QuestUpdated',
              'FlagSet',
              'RulingLogged',
            ].includes(String((event as { type?: unknown }).type))
          )
            registryEvents.push(event as RegistryEvent);
        }
        let nextWorld = current.world;
        for (const event of value?.events ?? []) {
          if (!event || typeof event !== 'object') continue;
          const item = event as Record<string, unknown>;
          if (item.type === 'NpcUpserted')
            nextWorld = {
              ...nextWorld,
              npcs: {
                ...nextWorld.npcs,
                [(item.npc as { id: string }).id]:
                  item.npc as WorldRegistry['npcs'][string],
              },
            };
          if (item.type === 'LocationUpserted')
            nextWorld = {
              ...nextWorld,
              locations: {
                ...nextWorld.locations,
                [(item.location as { id: string }).id]:
                  item.location as WorldRegistry['locations'][string],
              },
            };
          if (item.type === 'QuestUpdated')
            nextWorld = {
              ...nextWorld,
              quests: {
                ...nextWorld.quests,
                [(item.quest as { id: string }).id]:
                  item.quest as WorldRegistry['quests'][string],
              },
            };
          if (item.type === 'FlagSet')
            nextWorld = {
              ...nextWorld,
              flags: {
                ...nextWorld.flags,
                [(item.flag as { id: string }).id]:
                  item.flag as WorldRegistry['flags'][string],
              },
            };
          if (item.type === 'RulingLogged') {
            const ruling = item.ruling as { id: string };
            nextWorld = {
              ...nextWorld,
              rulings: [
                ...nextWorld.rulings.filter((entry) => entry.id !== ruling.id),
                ruling as WorldRegistry['rulings'][number],
              ],
            };
          }
        }
        return {
          ok: true,
          summary: result.summary,
          events:
            Array.isArray(result.events) &&
            result.events.every((entry) => typeof entry === 'string')
              ? (result.events as string[])
              : [],
          value: {
            events: value?.events ?? [],
            state: { ...current, world: nextWorld },
          },
        };
      },
      rulesLookup: (topic) => rulesLookup(this.db as Pool, topic),
    };

    const result = await runTurn({
      turnId: request.actionId,
      testMode: process.env.NODE_ENV === 'test',
      ...(process.env.LLM_FIXTURE_MODE ? { turnSeed: 0, testMode: true } : {}),
      prompt: {
        catalogVersion: state.catalogVersion ?? catalog.catalogVersion,
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
          registryFacts: memoryContext.registryFacts,
          retrievedMemory: memoryContext.retrievedMemory,
          playerText: `${request.playerName ?? 'Player'}: ${request.text}`,
          turns: state.lastNarration
            ? [
                {
                  playerText: state.lastPlayerText ?? '',
                  narration: state.lastNarration,
                },
              ]
            : [],
        },
      },
      context,
      adapter,
      toolMode: 'native',
      emit: (event) => onEvent(event as DMTurnEvent),
    });

    for (const event of result.events) {
      if (
        event &&
        typeof event === 'object' &&
        (event as { type?: string }).type === 'SceneClosed'
      ) {
        const closed = event as { sceneId: string; summary: string };
        const summaryAdapter = new MeteredLlmAdapter(
          new RecordedLlmAdapter({
            mode: this.fixtureMode,
            fixturePath: this.fixturePath,
            upstream: endpoint,
            allowRecord: process.env.NODE_ENV === 'test',
            environment: process.env.NODE_ENV,
            prefix: 'Lorekeep scene summary',
          }),
          new PostgresUsageSink(this.db),
          {
            sessionId: request.sessionId,
            turnId: request.actionId,
            purpose: 'summary',
            modelId: endpointSlot,
          },
        );
        await closeScene({
          sessionId: request.sessionId,
          sceneId: closed.sceneId,
          events: result.events.map((entry) => ({
            type: String((entry as { type?: unknown }).type ?? 'Unknown'),
            payload: entry,
          })),
          adapter: summaryAdapter,
          db: this.db as Pool,
        });
      }
    }
    return {
      ...result,
      events: [...result.events, ...registryEvents],
      state: {
        ...(result.state as GameState),
        lastNarration: result.narration,
        lastPlayerText: request.text,
      },
    };
  }
}
