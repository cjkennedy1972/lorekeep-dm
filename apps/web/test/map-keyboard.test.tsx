import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
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

  it('uses the active entity and delegates confirmed movement without local prediction', async () => {
    const store = setup();
    store.setTracker({
      round: 1,
      activeEntityId: 'hero',
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
    expect(screen.getByText(/Selected: Hero/)).toBeInTheDocument();
  });

  it('selects nothing and does not jump to initiative[0] when the active entity is hidden (null)', async () => {
    const store = setup();
    store.setTracker({
      round: 1,
      activeEntityId: null,
      initiative: [
        { entityId: 'hero', total: 10 },
        { entityId: 'goblin', total: 15 },
      ],
      resources: {},
    });
    const onMove = vi.fn();
    const user = userEvent.setup();
    render(<MapKeyboard store={store} onMove={onMove} />);
    screen.getByRole('application', { name: 'Battle map' }).focus();
    await user.keyboard('{Enter}{ArrowRight}{Enter}');
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.queryByText(/Selected: Hero/)).toBeNull();
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

describe('map pointer equivalent', () => {
  it('a cell pick enters move preview with visible Confirm and Cancel controls', async () => {
    const store = setup();
    const user = userEvent.setup();
    render(
      <MapKeyboard store={store}>
        {(pickCell) => (
          <button type="button" onClick={() => pickCell({ x: 3, y: 2 })}>
            Pick 4,3
          </button>
        )}
      </MapKeyboard>,
    );
    await user.click(screen.getByRole('button', { name: 'Pick 4,3' }));
    expect(
      screen.getByRole('application', { name: 'Battle map' }),
    ).toHaveAttribute('data-moving', 'true');
    expect(screen.getByText(/Move preview: 15 feet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm move' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Confirm move' }));
    expect(
      store.getState().mapEntities.find((item) => item.id === 'hero')?.pos,
    ).toEqual({ x: 3, y: 2 });
  });

  it('Cancel move leaves the token where it was', async () => {
    const store = setup();
    const user = userEvent.setup();
    render(
      <MapKeyboard store={store}>
        {(pickCell) => (
          <button type="button" onClick={() => pickCell({ x: 3, y: 2 })}>
            Pick 4,3
          </button>
        )}
      </MapKeyboard>,
    );
    await user.click(screen.getByRole('button', { name: 'Pick 4,3' }));
    await user.click(screen.getByRole('button', { name: 'Cancel move' }));
    expect(screen.queryByRole('button', { name: 'Confirm move' })).toBeNull();
    expect(
      store.getState().mapEntities.find((item) => item.id === 'hero')?.pos,
    ).toEqual({ x: 0, y: 2 });
  });

  it('Enter on Confirm activates the button without re-entering move mode', async () => {
    const store = setup();
    const user = userEvent.setup();
    render(
      <MapKeyboard store={store}>
        {(pickCell) => (
          <button type="button" onClick={() => pickCell({ x: 3, y: 2 })}>
            Pick 4,3
          </button>
        )}
      </MapKeyboard>,
    );
    await user.click(screen.getByRole('button', { name: 'Pick 4,3' }));
    screen.getByRole('button', { name: 'Confirm move' }).focus();
    await user.keyboard('{Enter}');
    expect(
      store.getState().mapEntities.find((item) => item.id === 'hero')?.pos,
    ).toEqual({ x: 3, y: 2 });
  });
});

describe('reaction prompt keyboard focus', () => {
  const prompt = {
    reactionId: 'r1',
    entityId: 'goblin',
    moverId: 'hero',
    trigger: 'leaves reach',
  };

  it('shows remaining seconds as text and keeps Tab inside the dialog', async () => {
    const store = setup();
    const user = userEvent.setup();
    const onReactionChoice = vi.fn();
    render(
      <MapKeyboard
        store={store}
        reactionPrompt={prompt}
        onReactionChoice={onReactionChoice}
        reactionRemainingMs={14_200}
      />,
    );
    expect(screen.getByText(/Respond within 15 seconds/)).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: 'Accept' });
    const decline = screen.getByRole('button', { name: 'Decline' });
    accept.focus();
    await user.keyboard('{Tab}');
    expect(decline).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(accept).toHaveFocus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(decline).toHaveFocus();
    expect(onReactionChoice).not.toHaveBeenCalled();
  });

  it('keeps Decline focused across countdown ticks so Enter declines', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const store = setup();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const onReactionChoice = vi.fn();
      // Mirrors Game.tsx: a 100 ms countdown re-renders the keyboard with the same reactionPrompt object.
      function Countdown() {
        const [remaining, setRemaining] = useState(15_000);
        useEffect(() => {
          const timer = window.setInterval(
            () => setRemaining((ms) => Math.max(0, ms - 100)),
            100,
          );
          return () => window.clearInterval(timer);
        }, []);
        return (
          <MapKeyboard
            store={store}
            reactionPrompt={prompt}
            onReactionChoice={onReactionChoice}
            reactionRemainingMs={remaining}
          />
        );
      }
      render(<Countdown />);
      expect(screen.getByRole('button', { name: 'Accept' })).toHaveFocus();
      await user.keyboard('{Tab}');
      const decline = screen.getByRole('button', { name: 'Decline' });
      expect(decline).toHaveFocus();
      // One act() per 100 ms tick so each countdown render commits separately; a single act() could batch them.
      for (let tick = 1; tick <= 4; tick++) {
        act(() => {
          vi.advanceTimersByTime(100);
        });
        expect(decline, `focus after countdown tick ${tick}`).toHaveFocus();
      }
      await user.keyboard('{Enter}');
      expect(onReactionChoice).toHaveBeenCalledTimes(1);
      expect(onReactionChoice).toHaveBeenCalledWith('r1', 'decline');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape declines through the existing take|decline wire', async () => {
    const store = setup();
    const user = userEvent.setup();
    const onReactionChoice = vi.fn();
    render(
      <MapKeyboard
        store={store}
        reactionPrompt={prompt}
        onReactionChoice={onReactionChoice}
      />,
    );
    screen.getByRole('button', { name: 'Accept' }).focus();
    await user.keyboard('{Escape}');
    expect(onReactionChoice).toHaveBeenCalledWith('r1', 'decline');
  });
});

describe('map announcements name entities, never raw ids', () => {
  it('announces selection, cycling and opportunity attacks by name, with no ent_ id or UUID', async () => {
    const heroId = '3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b';
    const store = createGameStore();
    store.setBattlemap(map);
    store.setMapEntities([
      {
        id: heroId,
        kind: 'character',
        pos: { x: 1, y: 2 },
        size: 1,
        hp: 12,
        team: 'heroes',
        speed: 30,
      },
      {
        id: 'ent_goblin',
        kind: 'monster',
        pos: { x: 0, y: 2 },
        size: 1,
        hp: 7,
        team: 'foes',
        speed: 30,
      },
    ]);
    store.applyEvent({
      type: 'CombatStarted',
      combatants: [
        { id: heroId, initiativeModifier: 2, speed: 30 },
        { id: 'ent_goblin', initiativeModifier: 1, speed: 30 },
      ],
    });
    store.applyEvent({ type: 'InitiativeRolled', entityId: heroId, total: 15 });
    store.applyEvent({
      type: 'InitiativeRolled',
      entityId: 'ent_goblin',
      total: 10,
    });
    store.applyEvent({ type: 'TurnStarted', entityId: heroId, round: 1 });
    const user = userEvent.setup();
    render(<MapKeyboard store={store} />);
    const live = () => screen.getByRole('status').textContent ?? '';
    const rawId = /ent_|[0-9a-f]{8}-[0-9a-f]{4}-/i;

    screen.getByRole('application', { name: 'Battle map' }).focus();
    await user.keyboard('y');
    expect(live()).toBe('Combatant selected at 2, 3.');

    await user.keyboard(']');
    expect(live()).toMatch(/^Goblin selected at 1, 3\.$/);

    await user.keyboard('{Enter}{ArrowRight}{Enter}');
    expect(live()).toBe(
      'Opportunity attack from Goblin. Choose accept or decline.',
    );

    for (const text of [live(), document.body.textContent ?? ''])
      expect(text).not.toMatch(rawId);
  });
});
