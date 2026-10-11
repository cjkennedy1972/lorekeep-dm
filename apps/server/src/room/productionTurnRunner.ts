import { AdventureSchema, type DMTurnEvent } from '@game/schema';
import type { RegistryEvent } from '../dm/memory.js';
import { RegistryMemory } from '../dm/memory.js';
import { closeScene } from '../dm/summarize.js';
import { loadContentTierState } from '../safety/tierLoader.js';
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
  loadAdventure,
  nextSceneAfterClose,
} from '@game/rules-engine/adventure-node';
import adventure01 from '../../../../packages/engine/adventures/01/adventure.json' with { type: 'json' };
import {
  createConfiguredAdapter,
  createEndpointEgress,
} from '../llm/config.js';
import { liveDmAllowed } from '../llm/liveDmGate.js';
import {
  fixtureModeFromEnvironment,
  RecordedLlmAdapter,
} from '../llm/recorded.js';
import type { LlmAdapter } from '../llm/adapter.js';
import {
  LiveDmRestrictedError,
  type SoloTurnRequest,
  type SoloTurnRunner,
} from './dmTurn.js';

type GameState = {
  characters?: Record<string, ToolExecutorState['actors'][string]>;
  gameEngine?: Record<string, unknown>;
  premise?: string;
  sceneId?: string;
  adventureCompleted?: boolean;
  sceneSummary?: string;
  adventureId?: string;
  catalogVersion?: string;
  difficulty?: string;
  lastNarration?: string;
  lastPlayerText?: string;
  world?: WorldRegistry;
};
type CombatOutput = {
  entities?: { id: string; hp: number }[];
  combat?: unknown;
  xp?: Record<string, number>;
  rng?: number;
};
/** Fold start/end combat facts into the persistent engine state. */
export function mergeCombatOutput<T extends object>(
  current: T,
  name: string | undefined,
  value: unknown,
): T {
  if (name !== 'start_combat' && name !== 'end_combat') return current;
  const out = value as CombatOutput;
  if (!out.entities || !out.combat) return current;
  return {
    ...current,
    entities: out.entities,
    combat: out.combat,
    xp: out.xp,
    hp: {
      ...(current as { hp?: Record<string, number> }).hp,
      ...Object.fromEntries(
        out.entities.map((entity) => [entity.id, entity.hp]),
      ),
    },
    ...(name === 'start_combat' ? { combatSeed: out.rng } : {}),
  };
}
/** Live combatant whose turn it is; not persisted. Null outside combat or once combat ended. */
function liveTurnActorId(state: unknown): string | null {
  const room = (
    state as {
      combatRoom?: {
        ended?: unknown;
        combat: {
          activeEntityId: string | null;
          initiative: readonly { entityId: string }[];
        };
      };
    }
  ).combatRoom;
  if (!room || room.ended) return null;
  return (
    room.combat.activeEntityId ?? room.combat.initiative[0]?.entityId ?? null
  );
}
const withoutCatalog = (engine: unknown) =>
  Object.fromEntries(
    Object.entries(engine as Record<string, unknown>).filter(
      ([key]) => key !== 'catalog',
    ),
  );
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
    /** A fixed adapter for deterministic tests; skips endpoint configuration. */
    private readonly adapterOverride?: LlmAdapter,
    private readonly liveDmAllowlistOnly = true,
    // ponytail: false until the M3-19 endpoint probe sets it, so mature stays unreachable.
    private readonly endpointAllowsMature = false,
  ) {}

  async run(
    request: SoloTurnRequest,
    onEvent: Parameters<SoloTurnRunner['run']>[1],
  ): Promise<TurnResult> {
    if (
      !(await liveDmAllowed(
        this.db,
        request.accountId,
        this.liveDmAllowlistOnly,
        this.fixtureMode,
      ))
    )
      throw new LiveDmRestrictedError();
    const endpointSlot = process.env.SOLO_TURN_ENDPOINT_SLOT ?? 'moderate';
    if (!['fast', 'frontier', 'moderate'].includes(endpointSlot))
      throw new Error('Solo turn endpoint slot is invalid');
    const endpoint =
      this.adapterOverride ??
      (await createConfiguredAdapter(
        this.db,
        endpointSlot as 'fast' | 'frontier' | 'moderate',
        this.egress,
        this.endpointMasterKey,
      ));
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
      !table.rows[0].catalog_version ||
      table.rows[0].catalog_version === this.catalog.catalogVersion
        ? this.catalog
        : catalogFromSnapshot(
            table.rows[0].catalog_version,
            table.rows[0].catalog_snapshot,
          );
    if (!catalog) throw new Error('Pinned catalog version unavailable');
    const state = asRecord(request.state) as GameState;
    const initialSceneId = state.sceneId;
    let transitionedSceneId: string | undefined;
    let adventureCompleted: boolean | undefined;
    const adventure =
      table.rows[0].adventure_id === 'adventure:01-hollow-under-marrowfell'
        ? loadAdventure(AdventureSchema.parse(adventure01), catalog)
        : undefined;
    const currentScene = adventure?.ok
      ? adventure.adventure.scenes.find((scene) => scene.id === initialSceneId)
      : undefined;
    const nextScenes = currentScene
      ? currentScene.nextSceneIds.flatMap((id) => {
          const scene = adventure!.ok
            ? adventure!.adventure.scenes.find(
                (candidate) => candidate.id === id,
              )
            : undefined;
          return scene
            ? [
                {
                  id: scene.id,
                  title: scene.title,
                  summary: scene.text.slice(0, 240),
                },
              ]
            : [];
        })
      : [];
    const savedCharacter = table.rows[0].character as unknown as
      | ToolExecutorState['actors'][string]
      | null;
    if (savedCharacter && !state.characters)
      state.characters = { [request.accountId]: savedCharacter };
    if (!state.premise) state.premise = table.rows[0].premise ?? undefined;
    const actors = state.characters ?? {};
    if (Object.keys(actors).length && !actors[request.accountId])
      throw new Error('Player character is not configured for this table');

    const llm = this.fixtureMode
      ? new RecordedLlmAdapter({
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
        })
      : endpoint;
    const adapter =
      this.adapterOverride ??
      new MeteredLlmAdapter(llm, new PostgresUsageSink(this.db), {
        sessionId: request.sessionId,
        turnId: request.actionId,
        purpose: 'narration',
        modelId: endpointSlot,
      });
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
          // Tools address actors by character id; the saved map is keyed by account id.
          actors: Object.fromEntries(
            Object.values(actors).map((actor) => [actor.id, actor]),
          ),
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
    const otherSeatIds = Object.entries(actors)
      .filter(([accountId]) => accountId !== request.accountId)
      .map(([, character]) => character.id);
    const context: DmToolContext = {
      seed: 0,
      rollIndex: 0,
      turnId: request.actionId,
      state,
      engineState,
      closeScene: ({ summary, nextSceneId }) => {
        if (!adventure?.ok || !initialSceneId)
          return {
            ok: false,
            error: 'unknown-tool',
            hint: 'Scene closing is unavailable outside an active solo adventure.',
          };
        if (nextSceneId && !currentScene?.nextSceneIds.includes(nextSceneId))
          return {
            ok: false,
            error: 'invalid-scene-transition',
            hint: 'Choose one of the authored next scenes listed in the context, or omit nextSceneId.',
          };
        const event = {
          type: 'SceneClosed',
          sceneId: initialSceneId,
          summary,
          ...(nextSceneId ? { nextSceneId } : {}),
        };
        return {
          ok: true,
          summary: 'The current scene was closed.',
          events: [],
          output: { events: [event] },
        };
      },
      commitState(previous, output) {
        return {
          ...(previous as GameState),
          gameEngine: withoutCatalog(output.nextState),
          characters: Object.fromEntries(
            Object.entries((previous as GameState).characters ?? actors).map(
              ([accountId, character]) => [
                accountId,
                (output.nextState as ToolExecutorState).actors[character.id] ??
                  character,
              ],
            ),
          ),
          world:
            (output.nextState as { world?: WorldRegistry }).world ??
            (previous as GameState).world,
        };
      },
      engineExecute(prior, call, seed) {
        const current = prior as ToolExecutorState & { world: WorldRegistry };
        const request = call as { name?: string; args?: unknown };
        const serializedArgs = JSON.stringify(request.args ?? {});
        if (otherSeatIds.some((id) => serializedArgs.includes(id)))
          return {
            ok: false,
            error: 'unknown-entity',
            hint: 'Only your own character can be named in this action.',
            events: [],
          };
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
          : execute(
              { ...current, turnActorId: liveTurnActorId(state) },
              call,
              seed,
            );
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
            state: {
              ...mergeCombatOutput(current, request.name, result.value),
              world: nextWorld,
            },
          },
        };
      },
      rulesLookup: (topic) => rulesLookup(this.db as Pool, topic),
    };

    // Snapshotted once here, before narration: an opt-out flipped during this narration lands on the next one.
    const { tier, stored } = await loadContentTierState(
      this.db,
      request.sessionId,
      this.endpointAllowsMature,
    );
    const tierEvents =
      tier === stored
        ? []
        : [{ type: 'ContentTierChanged', from: stored, to: tier }];
    onEvent({ type: 'NarrationTier', tier });
    const emittedSceneEvents: unknown[] = [];
    const result = await runTurn({
      signal: request.signal,
      turnId: request.actionId,
      allowClarification: request.allowClarification,
      clarificationAsked: request.clarificationAsked,
      testMode: process.env.NODE_ENV === 'test',
      ...(process.env.LLM_FIXTURE_MODE ? { turnSeed: 0, testMode: true } : {}),
      prompt: {
        catalogVersion: state.catalogVersion ?? catalog.catalogVersion,
        toolMode: 'native',
        sceneId: state.sceneId ?? request.sessionId,
        settingsHash: 'default',
        session: {
          contentTier: tier,
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
          ...(currentScene
            ? {
                currentScene: {
                  id: currentScene.id,
                  title: currentScene.title,
                  summary: currentScene.text.slice(0, 240),
                },
                nextScenes,
              }
            : {}),
        },
        activeMode:
          state &&
          typeof state === 'object' &&
          (state as { combatRoom?: unknown }).combatRoom
            ? 'combat'
            : 'exploration',
        turn: {
          state: { characters: Object.values(actors) },
          activeActorId: liveTurnActorId(state),
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
      emit: (event) => {
        const value = event as Record<string, unknown>;
        if (value.type === 'SceneClosed') emittedSceneEvents.push(value);
        onEvent(event as DMTurnEvent);
      },
    });

    // Tool-emitted events are already in result.events; only add ones that are not.
    const missingSceneEvents = emittedSceneEvents.filter(
      (event) => !result.events.includes(event),
    );
    if (missingSceneEvents.length)
      result.events = [...result.events, ...missingSceneEvents];
    for (const event of result.events) {
      if (
        event &&
        typeof event === 'object' &&
        (event as { type?: string }).type === 'SceneClosed'
      ) {
        const closed = event as {
          sceneId: string;
          summary: string;
          nextSceneId?: string;
        };
        const summaryAdapter = new MeteredLlmAdapter(
          this.fixtureMode
            ? new RecordedLlmAdapter({
                mode: this.fixtureMode,
                fixturePath: this.fixturePath,
                upstream: endpoint,
                allowRecord: process.env.NODE_ENV === 'test',
                environment: process.env.NODE_ENV,
                prefix: 'Lorekeep scene summary',
              })
            : endpoint,
          new PostgresUsageSink(this.db),
          {
            sessionId: request.sessionId,
            turnId: request.actionId,
            purpose: 'summary',
            modelId: endpointSlot,
          },
        );
        const transition =
          adventure?.ok && closed.sceneId === initialSceneId
            ? nextSceneAfterClose(
                adventure.adventure,
                closed.sceneId,
                closed.nextSceneId,
              )
            : undefined;
        let transitionEvent: Record<string, unknown> | undefined;
        if (transition?.completed) {
          adventureCompleted = true;
          transitionEvent = { ...closed, nextSceneId: null };
        } else if (transition) {
          transitionedSceneId = transition.sceneId;
          adventureCompleted = false;
          transitionEvent = { ...closed, nextSceneId: transition.sceneId };
        }
        if (transitionEvent)
          result.events = result.events.map((entry) =>
            entry === event ? transitionEvent : entry,
          );
        await closeScene({
          signal: request.signal,
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
      events: [...tierEvents, ...result.events, ...registryEvents],
      state: {
        ...(result.state as GameState),
        ...(transitionedSceneId ? { sceneId: transitionedSceneId } : {}),
        ...(adventureCompleted !== undefined ? { adventureCompleted } : {}),
        lastNarration: result.narration,
        lastPlayerText: request.text,
      },
    };
  }
}
