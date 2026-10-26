import { AdventureSchema, type DMTurnEvent } from '@game/schema';
import type { RegistryEvent } from '../dm/memory.js';
import { RegistryMemory } from '../dm/memory.js';
import { concealedEntities } from './eventVisibility.js';
import { closeScene, hiddenMatcher } from '../dm/summarize.js';
import {
  createSceneCloseExecutor,
  judgeLeaveIntent,
  type LeaveJudge,
} from './sceneCloseTool.js';
import {
  loadContentTierState,
  loadSeatedContentBoundaries,
} from '../safety/tierLoader.js';
import { MeteredLlmAdapter, PostgresUsageSink } from '../llm/metering.js';
import { LlmEndpointError } from '../llm/adapter.js';
import type { ContentTier } from '../safety/tier.js';
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
import { currentMemberSql } from './membership.js';
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
  configuredSoloEndpointSlot,
  sessionMatureEndpointAllowed,
} from '../llm/matureEndpoint.js';
import { createEndpointJudge } from '../safety/inputGate.js';
import { MODERATION_SECTIONS } from '../safety/moderationRubric.generated.js';
import type { Moderator } from '../safety/moderator.js';
import {
  fixtureModeFromEnvironment,
  RecordedLlmAdapter,
} from '../llm/recorded.js';
import type { LlmAdapter } from '../llm/adapter.js';
import type { RoomCombatState } from './combatTypes.js';
import {
  consumeOptionHandle,
  roomTurnKey,
  runCombatMapTool,
} from './combatDmTools.js';
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
  combatRoom?: RoomCombatState;
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
/** A combat is in progress (present and not ended). */
function combatLive(state: unknown): boolean {
  const room = (state as { combatRoom?: { ended?: unknown } } | undefined)
    ?.combatRoom;
  return !!room && !room.ended;
}
/** Narration-facing actor id: a hidden next combatant must not leak (ADR-034 §3). */
function narrationActorId(state: unknown): string | null {
  const id = liveTurnActorId(state);
  const room = (
    state as {
      combatRoom?: { entities?: readonly { id: string; hidden?: boolean }[] };
    }
  ).combatRoom;
  return room?.entities?.some((entity) => entity.id === id && entity.hidden)
    ? null
    : id;
}
function combatSpellMap(room: RoomCombatState, casterId: string) {
  const caster = room.entities.find((entity) => entity.id === casterId);
  if (!caster) return undefined;
  const target = (entity: (typeof room.entities)[number]) => ({
    id: entity.id,
    hp: entity.hp,
    maxHp: entity.maxHp,
    ...(entity.ac !== undefined ? { ac: entity.ac } : {}),
    abilities: entity.abilities ?? {
      str: 10,
      dex: 10,
      con: 10,
      int: 10,
      wis: 10,
      cha: 10,
    },
  });
  return {
    map: room.map,
    caster: { pos: caster.pos, size: caster.size },
    entities: room.entities
      .filter((entity) => entity.hp > 0 && !entity.fled)
      .map(({ id, pos, size }) => ({ id, pos, size })),
    targets: room.entities.map(target),
  };
}
const withoutCatalog = (engine: unknown) =>
  Object.fromEntries(
    Object.entries(engine as Record<string, unknown>).filter(
      ([key]) =>
        key !== 'catalog' &&
        key !== 'resources' &&
        key !== 'bonusActionSpellCast' &&
        key !== 'actionSpellCast',
    ),
  );
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Adapter-injected runner tests deliberately isolate orchestration from endpoint setup.
const TEST_ALLOW_MODERATOR: Moderator = {
  async moderate() {
    return {
      verdict: 'allow',
      category: 'other',
      source: 'judge',
      latencyMs: 0,
      unavailable: false,
    };
  },
};

const SHARED_WORLD_TOOLS = new Set([
  'upsert_npc',
  'upsert_location',
  'update_quest',
  'set_flag',
  'log_ruling',
]);
export function worldMutationRejection(name: string, isHost: boolean) {
  if (!SHARED_WORLD_TOOLS.has(name) || isHost) return undefined;
  return {
    ok: false as const,
    error: 'forbidden' as const,
    hint: 'Only the table host can change shared world state.',
  };
}

function refusalWatch(adapter: LlmAdapter, onRefusal: () => void): LlmAdapter {
  return {
    capabilities: () => adapter.capabilities(),
    probe: (signal) => adapter.probe(signal),
    async *complete(request) {
      try {
        yield* adapter.complete(request);
      } catch (error) {
        if (
          error instanceof LlmEndpointError &&
          error.code === 'endpoint-refusal'
        )
          onRefusal();
        throw error;
      }
    },
  };
}

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
    private readonly moderatorOverride?: Moderator,
    private readonly leaveJudgeOverride?: LeaveJudge,
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
    const endpointSlot = configuredSoloEndpointSlot();
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
      owner_account_id: string;
    }>(
      `SELECT s.name,s.catalog_version,pinned_catalog.entries AS catalog_snapshot,s.premise,s.adventure_id,s.character,s.owner_account_id
       FROM sessions s LEFT JOIN catalog_snapshots pinned_catalog ON pinned_catalog.catalog_version=s.catalog_version
       WHERE s.id=$1 AND s.status='active'`,
      [request.sessionId],
    );
    if (!table.rows[0]) throw new Error('Table state unavailable');
    const seat = await this.db.query(
      `SELECT 1 FROM sessions s WHERE s.id=$1 AND ${currentMemberSql('$2')} LIMIT 1`,
      [request.sessionId, request.accountId],
    );
    if (!seat.rows[0]) throw new Error('Player is not seated at this table');
    const tableName = table.rows[0].name;
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

    // Snapshot the tier and boundary union once for this turn. Free-text tool outputs
    // are screened before they enter the world state or the persisted event stream.
    const { tier, stored } = await loadContentTierState(
      this.db,
      request.sessionId,
      this.endpointAllowsMature ||
        (await sessionMatureEndpointAllowed(
          this.db,
          request.sessionId,
          endpointSlot,
        )),
    );
    const boundaries = await loadSeatedContentBoundaries(
      this.db,
      request.sessionId,
    );
    const tableLines = [
      ...boundaries.lines.map((line) => `line: ${line}`),
      ...boundaries.veils.map((veil) => `veil: ${veil}`),
    ];
    const outputModerator =
      this.moderatorOverride ??
      (this.adapterOverride && process.env.NODE_ENV === 'test'
        ? TEST_ALLOW_MODERATOR
        : createEndpointJudge(this.db));
    const allowPlayerVisibleText = async (text: string): Promise<boolean> => {
      try {
        const verdict = await outputModerator.moderate({
          text,
          tier,
          tableLines,
          direction: 'output',
        });
        return verdict.verdict === 'allow';
      } catch {
        return false;
      }
    };

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
    const judgeAdapter = new MeteredLlmAdapter(
      llm,
      new PostgresUsageSink(this.db),
      {
        sessionId: request.sessionId,
        turnId: request.actionId,
        purpose: 'classification',
        modelId: endpointSlot,
      },
    );
    const memory = new RegistryMemory(this.db as Pool);
    const registryEvents: RegistryEvent[] = [];
    // ADR-033 §6.8: a combat narration prompt carries engine handles only, so no memory is retrieved from free text.
    const narrating = request.combatNarration === true;
    const memoryContext = narrating
      ? { registryFacts: [], retrievedMemory: [] }
      : await memory.contextFor(
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
    engineState.targets = {
      ...Object.fromEntries(
        Object.values(actors).map((actor) => [
          actor.id,
          {
            id: actor.id,
            hp: actor.hp.current,
            maxHp: actor.hp.max,
            abilities: actor.abilities,
          },
        ]),
      ),
      ...(engineState.targets ?? {}),
    };
    // In combat the Room resource flag is authoritative across both player
    // commands and scripted DM tools. Outside combat, scope it to this DM turn.
    engineState.bonusActionSpellCast = state.combatRoom
      ? Object.fromEntries(
          Object.entries(state.combatRoom.combat.resources).map(
            ([entityId, resources]) => [
              entityId,
              resources.bonusActionSpellCast === true,
            ],
          ),
        )
      : {};
    engineState.actionSpellCast = state.combatRoom
      ? Object.fromEntries(
          Object.entries(state.combatRoom.combat.resources).map(
            ([entityId, resources]) => [
              entityId,
              resources.actionSpellCast === true,
            ],
          ),
        )
      : {};
    if (state.combatRoom)
      engineState.resources = Object.fromEntries(
        Object.entries(state.combatRoom.combat.resources).map(
          ([entityId, resources]) => [
            entityId,
            { action: resources.action, bonusAction: resources.bonusAction },
          ],
        ),
      );
    // Authoritative Room combat state for map tools; tracks every commit within this DM turn.
    let liveRoom = state.combatRoom;
    let pendingRoom: RoomCombatState | undefined;
    let spentHandle: string | undefined;
    const isHost = table.rows[0].owner_account_id === request.accountId;
    const otherSeatIds = Object.entries(actors)
      .filter(([accountId]) => accountId !== request.accountId)
      .map(([, character]) => character.id);
    const context: DmToolContext = {
      seed: 0,
      rollIndex: 0,
      turnId: request.actionId,
      state,
      engineState,
      closeScene: createSceneCloseExecutor({
        sceneId: adventure?.ok ? initialSceneId : undefined,
        nextSceneIds: currentScene?.nextSceneIds ?? [],
        allowSummary: allowPlayerVisibleText,
        playerText: request.text,
        judgeLeave:
          this.leaveJudgeOverride ??
          ((text) => judgeLeaveIntent(judgeAdapter, text, request.signal)),
      }),
      commitState(previous, output) {
        // Room rejects combat commands while turnInFlight (Room.ts:1347), and queued DM turns run serially.
        // These resource snapshots therefore cannot overwrite a concurrent combat spend.
        const nextEngine = output.nextState as ToolExecutorState & {
          resources?: Readonly<
            Record<string, { action: boolean; bonusAction: boolean }>
          >;
          bonusActionSpellCast?: Readonly<Record<string, boolean>>;
          actionSpellCast?: Readonly<Record<string, boolean>>;
        };
        const combatRoom = (previous as GameState).combatRoom;
        const updatedCombatRoom =
          combatRoom &&
          (nextEngine.resources ||
            nextEngine.bonusActionSpellCast ||
            nextEngine.actionSpellCast)
            ? {
                ...combatRoom,
                combat: {
                  ...combatRoom.combat,
                  resources: {
                    ...combatRoom.combat.resources,
                    ...Object.fromEntries(
                      Object.keys({
                        ...nextEngine.resources,
                        ...nextEngine.bonusActionSpellCast,
                        ...nextEngine.actionSpellCast,
                      }).flatMap((entityId) => {
                        const resources = combatRoom.combat.resources[entityId];
                        if (!resources) return [];
                        return [
                          [
                            entityId,
                            {
                              ...resources,
                              ...(nextEngine.resources?.[entityId]
                                ? {
                                    action:
                                      nextEngine.resources[entityId].action,
                                    bonusAction:
                                      nextEngine.resources[entityId]
                                        .bonusAction,
                                  }
                                : {}),
                              ...(nextEngine.bonusActionSpellCast?.[
                                entityId
                              ] !== undefined
                                ? {
                                    bonusActionSpellCast:
                                      nextEngine.bonusActionSpellCast[entityId],
                                  }
                                : {}),
                              ...(nextEngine.actionSpellCast?.[entityId] !==
                              undefined
                                ? {
                                    actionSpellCast:
                                      nextEngine.actionSpellCast[entityId],
                                  }
                                : {}),
                            },
                          ],
                        ];
                      }),
                    ),
                  },
                },
              }
            : combatRoom;
        const spent = spentHandle;
        spentHandle = undefined;
        const afterCast = updatedCombatRoom ?? combatRoom;
        const committedRoom =
          pendingRoom ??
          (spent && afterCast
            ? consumeOptionHandle(afterCast, spent)
            : updatedCombatRoom);
        pendingRoom = undefined;
        liveRoom = committedRoom;
        return {
          ...(previous as GameState),
          gameEngine: withoutCatalog(nextEngine),
          ...(committedRoom ? { combatRoom: committedRoom } : {}),
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
      async engineExecute(prior, call, seed) {
        const current = prior as ToolExecutorState & { world: WorldRegistry };
        const request = call as { name?: string; args?: unknown };
        if (request.name === 'call_for_rest') {
          const args = request.args as { kind?: unknown } | undefined;
          if (args?.kind !== 'short' && args?.kind !== 'long')
            return {
              ok: false,
              error: 'schema-violation',
              hint: 'Choose a short or long rest.',
              events: [],
            };
          const event = { type: 'RestVoteRequested', kind: args.kind };
          return {
            ok: true,
            summary: 'A party rest vote was requested.',
            events: ['RestVoteRequested'],
            value: { state: current, events: [event], rng: seed },
          };
        }
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
        const rejection = worldMutationRejection(request.name ?? '', isHost);
        if (rejection) return { ...rejection, events: [] };
        if (
          (request.name === 'move_to' ||
            request.name === 'suggest_area_target') &&
          liveRoom &&
          !liveRoom.ended
        ) {
          const out = runCombatMapTool(
            liveRoom,
            { name: request.name, args: request.args },
            { catalog: current.catalog, actors: current.actors },
          );
          if (!out.result.ok) return { ...out.result, events: [] };
          pendingRoom = out.room;
          const mapValue = out.result.value as {
            events?: unknown[];
            options?: { optionId: string; affected: unknown[] }[];
          };
          return {
            ok: true,
            summary: out.result.summary,
            events: out.result.events,
            value: {
              events: mapValue.events ?? [],
              state: current,
              // executeTool only reads options from value.options; this is how the model gets the handles.
              ...(mapValue.options
                ? {
                    options: mapValue.options.map((o) => ({
                      optionId: o.optionId,
                      label: `Area hitting ${o.affected.length} visible creature(s)`,
                    })),
                  }
                : {}),
            },
          };
        }
        const spellCasterId = (
          request.args as { casterId?: string } | undefined
        )?.casterId;
        const spellState =
          request.name === 'cast_spell' && state.combatRoom && spellCasterId
            ? {
                ...current,
                spellMap: combatSpellMap(state.combatRoom, spellCasterId),
                turnId: roomTurnKey(liveRoom ?? state.combatRoom),
                options: Object.fromEntries(
                  Object.entries(liveRoom?.optionHandles ?? {}).map(
                    ([optionId, handle]) => [optionId, { optionId, ...handle }],
                  ),
                ),
              }
            : current;
        const result = worldExecute
          ? worldExecute(current.world, request.args)
          : execute(
              { ...spellState, turnActorId: liveTurnActorId(state) },
              call,
              seed,
            );
        if (!result.ok) return { ...result, events: [] };
        // An area handle is single-use (ADR-022 §2.2): spend it on the cast that used it.
        const castTarget = (
          request.args as { target?: { kind?: string; ref?: string } }
        ).target;
        if (
          request.name === 'cast_spell' &&
          liveRoom &&
          castTarget?.kind === 'option' &&
          castTarget.ref
        )
          spentHandle = castTarget.ref;
        const value = result.value as
          | {
              events?: readonly unknown[];
              bonusActionSpellCast?: Readonly<Record<string, boolean>>;
              actionSpellCast?: Readonly<Record<string, boolean>>;
              resources?: Readonly<
                Record<string, { action: boolean; bonusAction: boolean }>
              >;
            }
          | undefined;
        const authoredRegistryEvents = (value?.events ?? []).filter(
          (event) =>
            !!event &&
            typeof event === 'object' &&
            [
              'NpcUpserted',
              'LocationUpserted',
              'QuestUpdated',
              'FlagSet',
              'RulingLogged',
            ].includes(String((event as { type?: unknown }).type)),
        );
        if (
          authoredRegistryEvents.length > 0 &&
          !(await allowPlayerVisibleText(
            authoredRegistryEvents
              .map((event) => JSON.stringify(event))
              .join('\n'),
          ))
        )
          return {
            ok: false,
            error: 'schema-violation',
            hint: 'The registry text was rejected by the table safety settings. Use safer wording.',
            events: [],
          };
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
              ...(value?.bonusActionSpellCast
                ? { bonusActionSpellCast: value.bonusActionSpellCast }
                : {}),
              ...(value?.actionSpellCast
                ? { actionSpellCast: value.actionSpellCast }
                : {}),
              ...(value?.resources ? { resources: value.resources } : {}),
              world: nextWorld,
            },
          },
        };
      },
      rulesLookup: (topic) => rulesLookup(this.db as Pool, topic),
    };

    onEvent({ type: 'NarrationTier', tier });
    const emittedSceneEvents: unknown[] = [];
    const attemptEvents: DMTurnEvent[] = [];
    let refused = false;
    const attempt = async (attemptTier: ContentTier) => {
      refused = false;
      const narration: DMTurnEvent[] = [];
      const result = await runTurn({
        signal: request.signal,
        turnId: request.actionId,
        allowClarification: request.allowClarification,
        clarificationAsked: request.clarificationAsked,
        testMode: process.env.NODE_ENV === 'test',
        ...(process.env.LLM_FIXTURE_MODE
          ? { turnSeed: 0, testMode: true }
          : {}),
        prompt: {
          catalogVersion: state.catalogVersion ?? catalog.catalogVersion,
          toolMode: 'native',
          sceneId: state.sceneId ?? request.sessionId,
          settingsHash: 'default',
          session: {
            contentTier: attemptTier,
            safetySettings: {
              // Player-typed boundaries stay out of combat narration; they still reach output moderation via tableLines.
              lines: narrating ? [] : boundaries.lines,
              veils: narrating ? [] : boundaries.veils,
              ...(attemptTier === 'mature'
                ? { matureClause: MODERATION_SECTIONS['clause:mature'] }
                : {}),
            },
            ...(request.steerAway ? { steerAway: true } : {}),
            partyRoster: Object.values(actors).map((actor) => ({
              id: actor.id,
              name: narrating ? actor.id : actor.name,
            })),
            premise: narrating
              ? 'A tabletop adventure.'
              : (state.premise ?? `A solo adventure at ${tableName}.`),
            sceneSummary: narrating
              ? ''
              : (state.sceneSummary ??
                'The party is at the beginning of its adventure.'),
            ...(currentScene && !narrating
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
          ...(request.combatNarration ? { readOnlyTools: true } : {}),
          activeMode:
            state &&
            typeof state === 'object' &&
            (state as { combatRoom?: unknown }).combatRoom
              ? 'combat'
              : 'exploration',
          turn: {
            state: {
              characters: Object.values(actors).map((actor) =>
                narrating ? { ...actor, name: actor.id } : actor,
              ),
            },
            lastRestVoteResult: request.lastRestVoteResult,
            activeActorId: narrationActorId(state),
            registryFacts: memoryContext.registryFacts,
            retrievedMemory: memoryContext.retrievedMemory,
            playerText: narrating
              ? request.text
              : `${request.playerName ?? 'Player'}: ${request.text}`,
            turns:
              narrating || combatLive(state)
                ? []
                : state.lastNarration
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
        adapter: refusalWatch(adapter, () => {
          refused = true;
        }),
        toolMode: 'native',
        outputModerator,
        outputTier: attemptTier,
        outputTableLines: tableLines,
        emit: (event) => {
          const value = event as Record<string, unknown>;
          if (value.type === 'SceneClosed') emittedSceneEvents.push(value);
          // Narration is held until this attempt settles, so a refused attempt's text is discarded whole.
          if (String(value.type).startsWith('Narration'))
            narration.push(event as DMTurnEvent);
          else attemptEvents.push(event as DMTurnEvent);
        },
      });
      return { result, narration, refused };
    };
    let attemptTier = tier;
    let settled = await attempt(attemptTier);
    if (settled.refused && attemptTier !== 'standard') {
      attemptEvents.length = 0;
      emittedSceneEvents.length = 0;
      registryEvents.length = 0;
      attemptTier = 'standard';
      settled = await attempt(attemptTier);
    }
    const { result, narration } = settled;
    const hiddenNow = concealedEntities({
      concealed: [
        ...concealedEntities(state),
        ...concealedEntities(result.state),
      ],
    });
    const publicRegistry = hiddenMatcher(hiddenNow);
    for (const event of narration) onEvent(event);
    // A failed attempt's tool, scene, and registry effects are discarded; only its narration reaches the client.
    const failed = result.fallback === 'endpoint-error';
    for (const event of attemptEvents) {
      const type = String((event as { type?: string }).type);
      if (!failed || type === 'TurnFallback') onEvent(event);
    }
    attemptEvents.length = 0;
    if (failed) {
      result.events = [];
      emittedSceneEvents.length = 0;
      registryEvents.length = 0;
    }
    const tierEvents =
      !failed && attemptTier !== stored
        ? [{ type: 'ContentTierChanged', from: stored, to: attemptTier }]
        : [];

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
          moderator: outputModerator,
          tier,
          tableLines,
          turnId: request.actionId,
          hidden: hiddenNow,
        });
      }
    }
    return {
      ...result,
      // ADR-034 §3: registry rows are served to every seat and to pending applicants.
      events: [
        ...tierEvents,
        ...result.events,
        ...registryEvents.filter((event) => !publicRegistry.mentions(event)),
      ],
      state: {
        ...(result.state as GameState),
        ...(transitionedSceneId ? { sceneId: transitionedSceneId } : {}),
        ...(adventureCompleted !== undefined ? { adventureCompleted } : {}),
        // Combat narration is engine-driven; it must not become post-combat DM continuity.
        ...(narrating
          ? {}
          : {
              lastNarration: result.narration,
              lastPlayerText: request.text,
            }),
      },
    };
  }
}
