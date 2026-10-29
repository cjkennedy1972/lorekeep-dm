// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Battlemap } from '@game/schema';
import { Game } from '../src/screens/Game.js';
import { gameStore } from '../src/state/store.js';
import { initialGameState } from '../src/state/gameStore.js';
import { http } from '../src/api.js';

const hoisted = vi.hoisted(() => ({
  send: vi.fn(() => true),
  room: undefined as unknown,
  account: { id: 'acct-1' },
}));
vi.mock('../src/room/useRoom.js', () => ({
  useRoom: () => ({
    room: hoisted.room,
    status: 'connected',
    send: hoisted.send,
  }),
}));

vi.mock('../src/auth.js', () => ({
  useAuth: () => ({ account: hoisted.account }),
}));

const map: Battlemap = {
  mapId: 'gate-fixture',
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

const seat = (seatId: string, accountId: string, isHost: boolean) => ({
  seatId,
  accountId,
  isSelf: seatId === 'seat-self',
  displayName: seatId === 'seat-self' ? 'Cy' : 'Round Guest',
  isHost,
  chatMuted: false,
  presence: 'online',
});

function mount(seats: ReturnType<typeof seat>[]) {
  hoisted.room = {
    seats,
    gameState: {
      characters: {},
      combatRoom: { entities: [], map },
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

describe('Game screen host gate', () => {
  beforeEach(() => {
    http.fetch = async () =>
      new Response(
        JSON.stringify({ game: { recap: 'A short recap.', name: 'Fixture' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, { get: () => () => undefined })) as never;
    hoisted.send.mockClear();
    gameStore.setCharacter(null);
    gameStore.setCombatState(initialGameState().combat);
  });

  it('hides host controls from a non-host seat', () => {
    mount([
      seat('seat-host', 'acct-2', true),
      seat('seat-self', 'acct-1', false),
    ]);
    expect(
      screen.queryByRole('heading', { name: 'Host controls' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'End the table' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Remove Round Guest/ }),
    ).not.toBeInTheDocument();
  });

  it('shows host controls to the host seat', () => {
    mount([
      seat('seat-self', 'acct-1', true),
      seat('seat-guest', 'acct-2', false),
    ]);
    expect(
      screen.getByRole('heading', { name: 'Host controls' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End the table' })).toBeEnabled();
  });
});
