import {
  apply,
  emptyCombatState,
  type CombatEvent,
  type CombatState,
} from '@game/rules-engine';
import type { Battlemap, Character, EngineEvent, GridPos } from '@game/schema';
import type { MapCell } from '../features/map/hitTest.js';
import type { MapViewport } from '../features/map/viewport.js';

export interface GameState {
  character: Character | null;
  combat: CombatState;
  battlemap: Battlemap | null;
  announcement: string;
  selectedCell: MapCell | null;
  viewport: MapViewport;
  mapEntities: {
    id: string;
    kind: 'character' | 'monster' | 'npc';
    pos: GridPos;
    size: number;
    hp: number;
    team?: string;
    speed?: number;
  }[];
}

export const initialGameState = (): GameState => ({
  character: null,
  combat: emptyCombatState(),
  battlemap: null,
  announcement: '',
  selectedCell: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  mapEntities: [],
});

/** Pure combat reducer retained for engine replay and previews. */
export function applyEvent(state: GameState, event: CombatEvent): GameState {
  return { ...state, combat: apply(state.combat, event) };
}

/** Apply authoritative character events immutably in the same store notification. */
export function applyCharacterEvent(
  character: Character | null,
  event: EngineEvent,
): Character | null {
  if (!character || !('entityId' in event) || event.entityId !== character.id)
    return character;
  switch (event.type) {
    case 'HpChanged':
      return { ...character, hp: { ...character.hp, current: event.hp } };
    case 'ConditionApplied':
      return {
        ...character,
        conditions: [
          ...character.conditions.filter(
            (item) => item.conditionId !== event.conditionId,
          ),
          {
            conditionId: event.conditionId,
            ...(event.source ? { source: event.source } : {}),
          },
        ],
      };
    case 'ConditionRemoved':
      return {
        ...character,
        conditions: character.conditions.filter(
          (item) => item.conditionId !== event.conditionId,
        ),
      };
    case 'SlotSpent': {
      const key = String(event.level);
      const slot = character.slots[key];
      if (!slot) return character;
      return {
        ...character,
        slots: {
          ...character.slots,
          [key]: { ...slot, used: Math.min(slot.max, slot.used + 1) },
        },
      };
    }
    default:
      return character;
  }
}

export interface GameStore {
  getState(): GameState;
  subscribe(listener: () => void): () => void;
  applyEvent(event: CombatEvent | EngineEvent): void;
  setCharacter(character: Character | null): void;
  setBattlemap(battlemap: Battlemap | null): void;
  setSelectedCell(cell: MapCell | null): void;
  setViewport(viewport: MapViewport): void;
  setMapEntities(entities: GameState['mapEntities']): void;
  setAnnouncement(message: string): void;
}

export function createGameStore(initial = initialGameState()): GameStore {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: GameState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    applyEvent(event) {
      if (
        event.type === 'HpChanged' ||
        event.type === 'ConditionApplied' ||
        event.type === 'ConditionRemoved' ||
        event.type === 'SlotSpent'
      ) {
        const character = applyCharacterEvent(state.character, event);
        const message =
          event.type === 'HpChanged' && character?.id === event.entityId
            ? `Hit points changed to ${event.hp} of ${character.hp.max}`
            : event.type === 'ConditionApplied' &&
                character?.id === event.entityId
              ? `${event.conditionId.replace(/^condition:/, '').replaceAll('-', ' ')} condition applied`
              : event.type === 'ConditionRemoved' &&
                  character?.id === event.entityId
                ? `${event.conditionId.replace(/^condition:/, '').replaceAll('-', ' ')} condition removed`
                : '';
        const announcement = message
          ? [state.announcement, message].filter(Boolean).slice(-3).join('. ')
          : state.announcement;
        set({ ...state, character, announcement });
      } else {
        set(applyEvent(state, event as CombatEvent));
      }
    },
    setCharacter: (character) => set({ ...state, character }),
    setBattlemap: (battlemap) => set({ ...state, battlemap }),
    setSelectedCell: (selectedCell) => set({ ...state, selectedCell }),
    setViewport: (viewport) => set({ ...state, viewport }),
    setMapEntities: (mapEntities) =>
      set({
        ...state,
        mapEntities: mapEntities.map((entity) => ({
          ...entity,
          pos: { ...entity.pos },
        })),
      }),
    setAnnouncement: (announcement) => set({ ...state, announcement }),
  };
}

export const gameStore = createGameStore();
