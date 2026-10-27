import type { Battlemap } from '@game/schema';

/** View-space options shared by renderers; map coordinates remain in cells. */
export interface MapView {
  readonly cellSize?: number;
  /** Keyboard or pointer cursor cell; drawn as a ring so keyboard users can see where they are. */
  readonly cursor?: { readonly x: number; readonly y: number } | null;
  readonly moving?: boolean;
}

/** Deterministic, serializable drawing vocabulary used by canvas and headless tests. */
export type MapDrawCommand =
  | {
      readonly type: 'terrain';
      readonly x: number;
      readonly y: number;
      readonly patternId: string;
      readonly terrainId: string;
      readonly moveCost: number;
      readonly blocksMove: boolean;
    }
  | { readonly type: 'grid'; readonly x: number; readonly y: number }
  | {
      readonly type: 'edge';
      readonly x: number;
      readonly y: number;
      readonly orientation: 'horizontal' | 'vertical';
      readonly kind: 'wall' | 'door' | 'window';
      readonly state?: 'open' | 'closed' | 'locked';
    }
  | {
      readonly type: 'feature';
      readonly featureId: string;
      readonly kind: string;
      readonly x: number;
      readonly y: number;
      readonly tags: readonly string[];
    }
  | {
      readonly type: 'marker';
      readonly markerId: string;
      readonly label: string;
      readonly x: number;
      readonly y: number;
    };

/** Rendering boundary intentionally receives readonly map state and emits no engine events. */
export interface MapRenderer {
  render(
    map: Readonly<Battlemap>,
    view?: Readonly<MapView>,
  ): readonly MapDrawCommand[];
}
