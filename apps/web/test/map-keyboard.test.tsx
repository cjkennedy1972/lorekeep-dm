import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Battlemap } from '@game/schema';
import { MapKeyboard } from '../src/features/map/keyboard.js';
import { createGameStore } from '../src/state/gameStore.js';

const map: Battlemap = {
  mapId: 'test',
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
  features: [],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
};
function setup() {
  const store = createGameStore();
  store.setBattlemap({
    ...map,
    palette: [
      ...map.palette,
      {
        terrainId: 'wall',
        moveCost: 1,
        blocksMove: true,
        blocksSight: true,
        cover: 'full',
        elevation: 0,
      },
    ],
    cells: [0, 8, 1, 1, 0, 30],
  });
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
      pos: { x: 7, y: 4 },
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

describe('map keyboard movement', () => {
  it('moves three squares by keyboard, confirms through the engine, and updates the store position', async () => {
    const store = setup();
    const user = userEvent.setup();
    render(<MapKeyboard store={store} />);
    const region = screen.getByRole('application', { name: 'Battle map' });
    region.focus();
    await user.keyboard('{Enter}{ArrowRight}{ArrowRight}{ArrowRight}{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('15 feet');
    expect(
      store.getState().mapEntities.find((item) => item.id === 'hero')?.pos,
    ).toEqual({ x: 3, y: 2 });
    expect(store.getState().combat.resources.hero?.movementRemaining).toBe(15);
  });

  it('uses the first tracker initiative entry and delegates confirmed movement without local prediction', async () => {
    const store = setup();
    store.setTracker({
      round: 1,
      activeEntityId: 'goblin',
      initiative: [
        { entityId: 'hero', total: 10 },
        { entityId: 'goblin', total: 15 },
      ],
      resources: {
        hero: {
          action: true,
          bonusAction: true,
          reaction: true,
          movementRemaining: 30,
        },
        goblin: {
          action: true,
          bonusAction: true,
          reaction: true,
          movementRemaining: 30,
        },
      },
    });
    const onMove = vi.fn();
    const user = userEvent.setup();
    render(<MapKeyboard store={store} onMove={onMove} />);
    const region = screen.getByRole('application', { name: 'Battle map' });
    region.focus();
    await user.keyboard('{Enter}{ArrowRight}{Enter}');
    expect(onMove).toHaveBeenCalledWith({ x: 1, y: 2 });
    expect(
      store.getState().mapEntities.find((item) => item.id === 'hero')?.pos,
    ).toEqual({ x: 0, y: 2 });
    expect(screen.getByText(/Selected: hero/)).toBeInTheDocument();
  });

  it('announces running cost on each keypress and rejects an illegal destination without moving', async () => {
    const store = setup();
    render(<MapKeyboard store={store} />);
    const region = screen.getByRole('application', { name: 'Battle map' });
    region.focus();
    fireEvent.keyDown(region, { key: 'Enter' });
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('Path cost 5 feet');
    fireEvent.keyDown(region, { key: 'ArrowUp' });
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Choose a reachable cell within your movement',
    );
    expect(
      store.getState().mapEntities.find((item) => item.id === 'hero')?.pos,
    ).toEqual({ x: 0, y: 2 });
  });

  it('offers a focusable opportunity-attack prompt and resolves a decline through the engine', async () => {
    const store = setup();
    store.setMapEntities([
      {
        id: 'hero',
        kind: 'character',
        pos: { x: 1, y: 2 },
        size: 1,
        hp: 12,
        team: 'heroes',
        speed: 30,
      },
      {
        id: 'goblin',
        kind: 'monster',
        pos: { x: 0, y: 2 },
        hp: 7,
        size: 1,
        team: 'foes',
        speed: 30,
      },
    ]);
    const onReactionResolved = vi.fn();
    const user = userEvent.setup();
    render(
      <MapKeyboard store={store} onReactionResolved={onReactionResolved} />,
    );
    const region = screen.getByRole('application', { name: 'Battle map' });
    region.focus();
    await user.keyboard('{Enter}{ArrowRight}{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Opportunity attack' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onReactionResolved).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
    );
  });
});
