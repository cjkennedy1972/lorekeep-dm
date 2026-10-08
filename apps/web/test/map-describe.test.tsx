import { axe } from 'jest-axe';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { describe as describeEngine } from '@game/rules-engine';
import type { Battlemap } from '@game/schema';
import { Describe } from '../src/features/map/Describe.js';
import { TokenTable } from '../src/features/map/TokenTable.js';
import { createGameStore } from '../src/state/gameStore.js';

const map: Battlemap = {
  mapId: 'a11y-fixture',
  w: 8,
  h: 5,
  palette: [
    {
      terrainId: 'floor',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      elevation: 0,
    },
  ],
  cells: [0, 40],
  edges: [],
  features: [
    {
      featureId: 'barrel',
      kind: 'barrel',
      cells: [{ x: 2, y: 2 }],
      tags: ['half-cover'],
    },
  ],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
};
function setup() {
  const store = createGameStore();
  store.setBattlemap(map);
  store.setMapEntities([
    {
      id: 'hero',
      kind: 'character',
      pos: { x: 0, y: 2 },
      size: 1,
      hp: 12,
      team: 'heroes',
      speed: 30,
    },
    {
      id: 'goblin',
      kind: 'monster',
      pos: { x: 4, y: 2 },
      size: 1,
      hp: 7,
      team: 'foes',
      speed: 30,
    },
  ]);
  store.applyEvent({
    type: 'CombatStarted',
    combatants: [
      { id: 'hero', initiativeModifier: 2, speed: 30 },
      { id: 'goblin', initiativeModifier: 1, speed: 30 },
    ],
  });
  store.applyEvent({ type: 'InitiativeRolled', entityId: 'hero', total: 15 });
  store.applyEvent({ type: 'InitiativeRolled', entityId: 'goblin', total: 10 });
  store.applyEvent({ type: 'TurnStarted', entityId: 'hero', round: 1 });
  return store;
}

describe('battlefield description and token list', () => {
  it('renders exactly the engine description for the selected verbosity', () => {
    const store = setup();
    render(<Describe store={store} />);
    fireEvent.click(
      screen.getByRole('button', { name: /Describe battlefield/ }),
    );
    const state = store.getState();
    const expected = describeEngine(
      {
        map,
        entities: state.mapEntities,
        resources: { hero: { movementRemaining: 30 } },
      },
      'hero',
      { verbosity: 'standard' },
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('announces once on a turn change, and does not repeat when movement changes', () => {
    const store = setup();
    render(<Describe store={store} />);
    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('30 feet movement remaining');
    act(() =>
      store.applyEvent({ type: 'MovementSpent', entityId: 'hero', feet: 5 }),
    );
    expect(live).toHaveTextContent('30 feet movement remaining');
    act(() =>
      store.applyEvent({ type: 'TurnStarted', entityId: 'goblin', round: 1 }),
    );
    expect(live).toHaveTextContent('goblin: 30 feet movement remaining');
  });

  it('lists every token and feature and toggles distance ordering', () => {
    const store = setup();
    render(<TokenTable store={store} />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(
      within(table).getByRole('row', { name: /barrel/ }),
    ).toBeInTheDocument();
    const names = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent);
    expect(names()[0]).toContain('hero');
    fireEvent.click(screen.getByRole('button', { name: 'Sort by distance' }));
    expect(names()[0]).toContain('goblin');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('passes axe accessibility checks', async () => {
    const store = setup();
    const { container } = render(
      <>
        <Describe store={store} />
        <TokenTable store={store} />
      </>,
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});
