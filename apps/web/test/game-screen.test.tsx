// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Battlemap, ServerMessage } from '@game/schema';
import { Game } from '../src/screens/Game.js';
import { gameStore } from '../src/state/store.js';
import { initialGameState } from '../src/state/gameStore.js';
import { http } from '../src/api.js';

const hoisted = vi.hoisted(() => ({
  send: vi.fn(() => true),
  onMessage: undefined as ((m: ServerMessage) => void) | undefined,
  room: undefined as unknown,
  account: { id: 'acct-1' },
}));
vi.mock('../src/room/useRoom.js', () => ({
  useRoom: (opts: { onMessage: (m: ServerMessage) => void }) => {
    hoisted.onMessage = opts.onMessage;
    return { room: hoisted.room, status: 'connected', send: hoisted.send };
  },
}));

vi.mock('../src/auth.js', () => ({
  useAuth: () => ({ account: hoisted.account }),
}));

const map: Battlemap = {
  mapId: 'game-fixture',
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
const HERO_ID = '00000000-0000-4000-8000-0000000000aa';
const hero = {
  id: HERO_ID,
  name: 'Aria',
  speciesId: 'species:human',
  classId: 'class:wizard',
  backgroundId: 'background:sage',
  level: 1,
  abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
  proficiencies: { skills: [], saves: ['int', 'wis'], tools: [] },
  equipment: [],
  spellsKnown: [],
  spellsPrepared: [],
  slots: { '1': { max: 2, used: 0 } },
  hp: { current: 30, max: 30, temp: 0 },
  conditions: [],
};
const entities = [
  {
    id: HERO_ID,
    kind: 'character',
    team: 'party',
    pos: { x: 1, y: 2 },
    size: 1,
    hp: 30,
  },
  {
    id: 'ent_goblin',
    kind: 'monster',
    team: 'enemies',
    pos: { x: 5, y: 2 },
    size: 1,
    hp: 7,
    hpState: 'healthy',
  },
];
const resources = {
  [HERO_ID]: {
    action: true,
    bonusAction: true,
    reaction: true,
    movementRemaining: 30,
  },
  ent_goblin: {
    action: true,
    bonusAction: true,
    reaction: true,
    movementRemaining: 30,
  },
};
const tracker = (order: string[]) => ({
  round: 1,
  activeEntityId: HERO_ID,
  initiative: order.map((entityId, i) => ({ entityId, total: 20 - i })),
  resources,
  entities,
});
let seq = 0;
const push = (type: string, payload: Record<string, unknown>) =>
  act(() => {
    hoisted.onMessage!({ seq: ++seq, type, payload } as ServerMessage);
  });

function mount() {
  hoisted.room = {
    gameState: {
      characters: { 'acct-1': hero },
      combatRoom: { entities, map },
    },
  };
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Game />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Game screen (live Room)', () => {
  beforeEach(() => {
    http.fetch = async () =>
      new Response(
        JSON.stringify({ game: { recap: 'A short recap.', name: 'Fixture' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, { get: () => () => undefined })) as never;
    hoisted.send.mockClear();
    seq = 0;
    gameStore.setCharacter(null);
    gameStore.setCombatState(initialGameState().combat);
  });

  it('sends flat CombatCommand payloads the server schema accepts', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    await user.click(screen.getByRole('button', { name: 'End turn' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'end-turn',
    });
    await user.click(
      screen.getByRole('button', { name: 'Refresh combat options' }),
    );
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'options',
    });
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
        { kind: 'move', optionId: 'm', destination: { x: 2, y: 2 }, cost: 5 },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Attack ent_goblin' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'staff',
    });
    await user.click(screen.getByRole('button', { name: /Move to 2, 2/ }));
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'move',
      destination: { x: 2, y: 2 },
    });
  });

  it('shows pending immediately on submit and clears it on the matching narration', async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    expect(screen.getByText('Queued: I search the room.')).toBeInTheDocument();
    expect(hoisted.send).toHaveBeenLastCalledWith('PlayerAction', {
      text: 'I search the room.',
    });
    push('ActionQueued', { actionId: 'server-action-1' });
    push('NarrationCompleted', {
      actionId: 'server-action-1',
      turnId: 'turn-1',
      text: 'You find a key.',
    });
    expect(
      screen.queryByText('Queued: I search the room.'),
    ).not.toBeInTheDocument();
  });

  it('displays tool rejection neutrally without exposing internal details', () => {
    mount();
    push('ToolRejected', { turnId: 'turn-1' });
    expect(
      screen.getByText(/The DM could not apply part of that action\./),
    ).toBeInTheDocument();
  });

  it('highlights exactly the first tracker entry in the list and on the token', () => {
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    const list = screen.getByRole('list', { name: 'Initiative tracker' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(items[1]).not.toHaveAttribute('aria-current');
    const tokens = within(
      screen.getByRole('list', { name: 'Combat tokens' }),
    ).getAllByRole('listitem');
    const active = tokens.filter(
      (t) => t.getAttribute('data-active') === 'true',
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toContain('ent_goblin');
    // order changes -> highlight follows the first entry
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    const after = within(
      screen.getByRole('list', { name: 'Combat tokens' }),
    ).getAllByRole('listitem');
    expect(
      after.filter((t) => t.getAttribute('data-active') === 'true'),
    ).toHaveLength(1);
    expect(
      after.find((t) => t.getAttribute('data-active') === 'true')!.textContent,
    ).toContain(HERO_ID);
  });

  it('announces the battlefield once per turn in a polite live region, not per event', () => {
    mount();
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    const live = screen
      .getAllByRole('status')
      .find((el) => /movement remaining/.test(el.textContent ?? ''));
    expect(live).toBeDefined();
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live!.textContent).toMatch(
      new RegExp(
        `${HERO_ID}: 30 feet movement remaining\\. Threats within 30 feet: `,
      ),
    );
    const first = live!.textContent;
    push('CombatEvents', {
      events: [{ type: 'HpChanged', entityId: 'ent_goblin', delta: -3, hp: 4 }],
    });
    expect(live!.textContent).toBe(first);
    // next turn (round change keyed identity) re-announces
    push('CombatTracker', { ...tracker(['ent_goblin', HERO_ID]), round: 2 });
    expect(
      screen
        .getAllByRole('status')
        .find((el) => /movement remaining/.test(el.textContent ?? ''))!
        .textContent,
    ).toMatch(/ent_goblin: /);
  });

  it('updates the character sheet HP and slots within 1 s of the event', async () => {
    mount();
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    expect(screen.getAllByText(/30/).length).toBeGreaterThan(0);
    const started = performance.now();
    push('CombatEvents', {
      events: [
        { type: 'HpChanged', entityId: HERO_ID, delta: -9, hp: 21 },
        { type: 'SlotSpent', entityId: HERO_ID, level: 1 },
      ],
    });
    const state = gameStore.getState().character!;
    expect(state.hp.current).toBe(21);
    expect(state.slots['1']!.used).toBe(1);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(
      await screen.findByText(/Hit points changed to 21 of 30/, undefined, {
        timeout: 1000,
      }),
    ).toBeInTheDocument();
  });

  it('has no pointer-only action: canvas is decorative and every control is a keyboard-operable element', async () => {
    const user = userEvent.setup();
    const { container } = mount();
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    const canvas = container.querySelector('canvas')!;
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas.onclick).toBeNull();
    expect(canvas.onpointerdown).toBeNull();
    expect(container.querySelector('[draggable="true"]')).toBeNull();
    // the move that a pointer could do is available from the keyboard map and as buttons
    const map = screen.getByRole('application', { name: 'Battle map' });
    expect(map).toHaveAttribute('tabindex', '0');
    map.focus();
    await user.keyboard('{Enter}');
    expect(map).toHaveAttribute('data-moving', 'true');
    for (const button of screen.getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON');
    }
  });
});
