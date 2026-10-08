import type { GridPos } from '@game/schema';
import {
  affectedEntities,
  areaCells,
  coverBetween,
  hasLineOfSight,
  path,
  reachable,
  threatenedBy,
  type AreaTemplate,
  type MovementState,
  type MovementEntity,
} from '@game/rules-engine';

export type OverlayKind =
  | 'reachable'
  | 'path'
  | 'threat'
  | 'area'
  | 'los'
  | 'cover';
export type OverlayToggles = Readonly<Record<OverlayKind, boolean>>;
export const DEFAULT_OVERLAY_TOGGLES: OverlayToggles = Object.freeze({
  reachable: false,
  path: false,
  threat: false,
  area: false,
  los: false,
  cover: false,
});

export interface OverlayState extends MovementState {
  readonly entities: readonly (MovementEntity & { name?: string })[];
}
export interface OverlayRequest {
  readonly entityId: string;
  readonly goal?: GridPos;
  readonly area?: {
    template: AreaTemplate;
    origin: GridPos;
    direction?: GridPos;
  };
  readonly targetId?: string;
  readonly losTargetId?: string;
  readonly toggles?: Partial<OverlayToggles>;
}
export type OverlayResult = {
  readonly enabled: OverlayToggles;
  readonly reachable?: ReturnType<typeof reachable>;
  readonly path?: ReturnType<typeof path>;
  readonly pathCostLabel?: string;
  readonly area?: {
    cells: GridPos[];
    affected: ReturnType<typeof affectedEntities>;
    affectedNames: string[];
  };
  readonly threatened?: string[];
  readonly los?: boolean;
  readonly cover?: ReturnType<typeof coverBetween>;
};

/** Engine-derived map previews. Every optional preview is opt-in and mirrors engine results. */
export function computeMapOverlays(
  state: OverlayState,
  request: OverlayRequest,
): OverlayResult {
  const enabled = { ...DEFAULT_OVERLAY_TOGGLES, ...request.toggles };
  const entity = state.entities.find(
    (candidate) => candidate.id === request.entityId,
  );
  if (!entity) throw new Error(`Unknown overlay entity: ${request.entityId}`);
  const result: {
    enabled: OverlayToggles;
    reachable?: ReturnType<typeof reachable>;
    path?: ReturnType<typeof path>;
    pathCostLabel?: string;
    area?: OverlayResult['area'];
    threatened?: string[];
    los?: boolean;
    cover?: ReturnType<typeof coverBetween>;
  } = { enabled };

  if (enabled.reachable) result.reachable = reachable(state, entity.id);
  if (enabled.path && request.goal) {
    result.path = path(state, entity.id, request.goal);
    result.pathCostLabel =
      'cost' in result.path
        ? `${result.path.cost} ft`
        : `Illegal: ${result.path.reason}`;
  }
  if (enabled.threat)
    result.threatened = threatenedBy(entity, state.entities).map(
      (item) => item.id,
    );
  if (enabled.area && request.area) {
    const cells = areaCells(
      state.map,
      request.area.template,
      request.area.origin,
      request.area.direction,
    );
    const affected = affectedEntities(cells, state, request.area.origin);
    result.area = {
      cells,
      affected,
      affectedNames: affected.map(
        ({ id }) => state.entities.find((item) => item.id === id)?.name ?? id,
      ),
    };
  }
  if (enabled.los && request.losTargetId) {
    const target = state.entities.find(
      (item) => item.id === request.losTargetId,
    );
    if (!target) throw new Error(`Unknown LOS target: ${request.losTargetId}`);
    result.los = hasLineOfSight(state.map, entity, target);
  }
  if (enabled.cover && request.targetId) {
    const target = state.entities.find((item) => item.id === request.targetId);
    if (!target) throw new Error(`Unknown cover target: ${request.targetId}`);
    result.cover = coverBetween(state.map, entity, target);
  }
  return result;
}

/** High-contrast rendering hint: patterns and outlines accompany, never replace, color. */
export const OVERLAY_STYLES = Object.freeze({
  reachable: { pattern: 'diagonal-hatch', outline: 'solid' },
  path: { pattern: 'dashed-hatch', outline: 'double' },
  threat: { pattern: 'crosshatch', outline: 'dashed' },
  area: { pattern: 'dots', outline: 'solid' },
  los: { pattern: 'none', outline: 'dotted' },
  cover: { pattern: 'none', outline: 'badge' },
} as const);
