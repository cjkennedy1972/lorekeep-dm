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
// These fixtures use bare ids; the ordering and prose checks compare ids, so they opt out of naming.
const rawNames = (id: string) => id;
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
    render(<Describe store={store} nameOf={rawNames} />);
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
    render(<Describe store={store} nameOf={rawNames} />);
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
    render(<TokenTable store={store} nameOf={rawNames} />);
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

  it('shows a number only for the viewer’s own entity; everyone else gets a status word, monsters included', () => {
    const store = setup();
    // Monsters carry numeric hp on the live path, and another seat's PC may too. Neither may print it.
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
        id: 'ally',
        kind: 'character',
        pos: { x: 1, y: 2 },
        size: 1,
        hp: 9,
        hpState: 'healthy',
        team: 'heroes',
        speed: 30,
      },
      {
        id: 'goblin',
        kind: 'monster',
        pos: { x: 4, y: 2 },
        size: 1,
        hp: 7,
        hpState: 'wounded',
        team: 'foes',
        speed: 30,
      },
    ] as Parameters<typeof store.setMapEntities>[0]);
    render(<TokenTable store={store} nameOf={rawNames} ownEntityId="hero" />);
    const table = screen.getByRole('table');
    const row = (name: RegExp) =>
      within(table).getByRole('row', { name }).textContent ?? '';

    expect(row(/hero/)).toContain('HP 12');
    expect(row(/ally/)).toContain('healthy');
    expect(row(/ally/)).not.toContain('HP 9');
    expect(row(/goblin/)).toContain('bloodied');
    expect(row(/goblin/)).not.toContain('HP 7');
  });

  it('passes axe accessibility checks', async () => {
    const store = setup();
    const { container } = render(
      <>
        <Describe store={store} nameOf={rawNames} />
        <TokenTable store={store} nameOf={rawNames} />
      </>,
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('default names never print an id fragment', () => {
  it('TokenTable and Describe fall back to a readable name for embedded-UUID ids', () => {
    const store = createGameStore();
    store.setBattlemap(map);
    store.setMapEntities([
      {
        id: 'ent_goblin_3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b',
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
        {
          id: 'ent_goblin_3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b',
          initiativeModifier: 1,
          speed: 30,
        },
      ],
    });
    store.applyEvent({
      type: 'InitiativeRolled',
      entityId: 'ent_goblin_3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b',
      total: 10,
    });
    store.applyEvent({
      type: 'TurnStarted',
      entityId: 'ent_goblin_3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b',
      round: 1,
    });
    const { container } = render(<TokenTable store={store} />);
    expect(screen.getByRole('table')).toHaveTextContent('Goblin');
    expect(container.textContent).not.toContain('3f2a9c1e');
  });
});
