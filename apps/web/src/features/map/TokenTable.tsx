import { distance, type Placed } from '@game/rules-engine';
import { useEffect, useMemo, useState } from 'react';
import { gameStore, type GameState } from '../../state/gameStore.js';

type Props = { store?: typeof gameStore; viewerId?: string };
type Row = {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  feet: number;
  state: string;
};

/** Screen-reader and keyboard-friendly inventory of every map token and feature. */
export function TokenTable({ store = gameStore, viewerId }: Props) {
  const [state, setState] = useState<GameState>(() => store.getState());
  const [ascending, setAscending] = useState(true);
  useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  const viewer =
    state.mapEntities.find(
      (item) => item.id === (viewerId ?? state.combat.activeEntityId),
    ) ?? state.mapEntities[0];
  const rows = useMemo(() => {
    if (!state.battlemap) return [] as Row[];
    const tokens: Row[] = state.mapEntities.map((entity) => ({
      id: entity.id,
      name: entity.id,
      kind: entity.kind,
      x: entity.pos.x,
      y: entity.pos.y,
      feet: viewer
        ? distance(
            viewer as Placed,
            entity as Placed,
            state.battlemap!.diagonalRule,
          )
        : 0,
      // Enemy HP is qualitative on the live path (hpState); sandbox entities carry exact HP.
      state:
        typeof entity.hp === 'number'
          ? `HP ${entity.hp}`
          : String((entity as { hpState?: string }).hpState ?? 'unknown'),
    }));
    const features: Row[] = state.battlemap.features.map((feature) => {
      const cell = feature.cells[0]!;
      const featurePos = { pos: cell, size: 1 };
      return {
        id: feature.featureId,
        name: feature.kind,
        kind: 'terrain',
        x: cell.x,
        y: cell.y,
        feet: viewer
          ? distance(
              viewer as Placed,
              featurePos,
              state.battlemap!.diagonalRule,
            )
          : 0,
        state: feature.tags.length
          ? feature.tags.join(', ')
          : 'terrain feature',
      };
    });
    return [...tokens, ...features].sort(
      (a, b) =>
        (ascending ? 1 : -1) *
        (a.feet - b.feet ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id)),
    );
  }, [state, viewer, ascending]);
  return (
    <section aria-label="Tokens and terrain">
      <h2>Tokens and terrain</h2>
      <button
        type="button"
        aria-label="Sort by distance"
        onClick={() => setAscending((value) => !value)}
      >
        Distance {ascending ? 'nearest first' : 'farthest first'}
      </button>
      <table>
        <caption>Every token and terrain feature on the battlefield</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Coordinates</th>
            <th scope="col">Distance</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.name}</th>
              <td>{row.kind}</td>
              <td>
                {String.fromCharCode(65 + row.x)}
                {row.y + 1}
              </td>
              <td>{row.feet} ft</td>
              <td>{row.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
