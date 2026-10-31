// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Battlemap, ServerMessage } from '@game/schema';
import { Game } from '../src/screens/Game.js';
import { gameStore } from '../src/state/store.js';
import { initialGameState } from '../src/state/gameStore.js';
import { http } from '../src/api.js';

const hoisted = vi.hoisted(() => ({
  room: undefined as unknown,
  account: { id: 'acct-1' },
  onMessage: undefined as ((m: ServerMessage) => void) | undefined,
}));
vi.mock('../src/room/useRoom.js', () => ({
  useRoom: (opts: { onMessage: (m: ServerMessage) => void }) => {
    hoisted.onMessage = opts.onMessage;
    return {
      room: hoisted.room,
      status: 'connected',
      send: () => true,
    };
  },
}));

vi.mock('../src/auth.js', () => ({
  useAuth: () => ({ account: hoisted.account }),
}));

const map: Battlemap = {
  mapId: 'solo-fixture',
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

function roomState(extra: Record<string, unknown> = {}) {
  return {
    seats: [seat('seat-self', 'acct-1', true)],
    gameState: {
      characters: {},
      combatRoom: { entities: [], map },
    },
    ...extra,
  };
}

function tree() {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Game />} />
      </Routes>
    </MemoryRouter>
  );
}

function mount(extra: Record<string, unknown> = {}) {
  hoisted.room = roomState(extra);
  return render(tree());
}

describe('Game screen Party chat follows the table mode', () => {
  beforeEach(() => {
    http.fetch = async () =>
      new Response(
        JSON.stringify({ game: { recap: 'A short recap.', name: 'Fixture' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, { get: () => () => undefined })) as never;
    gameStore.setCharacter(null);
    gameStore.setCombatState(initialGameState().combat);
    hoisted.account = { id: 'acct-1' };
  });

  it('a solo-mode host keeps Host tools but gets no empty Party chat card', () => {
    mount({ tableMode: 'solo' });
    expect(screen.getByText('Host tools')).toBeInTheDocument();
    expect(screen.queryByText('Party chat')).not.toBeInTheDocument();
  });

  it('a party-mode table with only its host seated keeps Party chat', () => {
    mount({ tableMode: 'party' });
    expect(screen.getByText('Host tools')).toBeInTheDocument();
    expect(screen.getByText('Party chat')).toBeInTheDocument();
  });

  it('a party-mode table keeps Party chat for a seated non-host, without Host tools', () => {
    hoisted.account = { id: 'acct-2' };
    mount({
      tableMode: 'party',
      seats: [
        seat('seat-host', 'acct-1', true),
        { ...seat('seat-self', 'acct-2', false), isSelf: true },
      ],
    });
    expect(screen.getByText('Party chat')).toBeInTheDocument();
    expect(screen.queryByText('Host tools')).not.toBeInTheDocument();
  });

  it('a solo-mode table hides Party chat even while a late-join request waits', () => {
    mount({
      tableMode: 'solo',
      lateJoinRequests: [
        {
          requestId: '6f1d2c3a-4b5e-4f70-8a9b-0c1d2e3f4a5b',
          accountId: 'acct-2',
          expiresAt: Date.now() + 60_000,
        },
      ],
    });
    expect(screen.queryByText('Party chat')).not.toBeInTheDocument();
  });

  it('a reconnect that carries the party mode brings Party chat back', () => {
    mount({ tableMode: 'solo' });
    expect(screen.queryByText('Party chat')).not.toBeInTheDocument();
    hoisted.room = roomState({ tableMode: 'party' });
    const { rerender } = render(tree());
    rerender(tree());
    expect(screen.getByText('Party chat')).toBeInTheDocument();
  });

  it('an older server with no tableMode keeps Party chat for a second seat', () => {
    mount({
      seats: [
        seat('seat-self', 'acct-1', true),
        seat('seat-guest', 'acct-2', false),
      ],
    });
    expect(screen.getByText('Party chat')).toBeInTheDocument();
  });

  it('an older server with no tableMode hides Party chat for a lone host', () => {
    mount();
    expect(screen.queryByText('Party chat')).not.toBeInTheDocument();
  });

  it('an older server with no tableMode keeps Party chat while a late-join request waits', () => {
    mount({
      lateJoinRequests: [
        {
          requestId: '6f1d2c3a-4b5e-4f70-8a9b-0c1d2e3f4a5b',
          accountId: 'acct-2',
          expiresAt: Date.now() + 60_000,
        },
      ],
    });
    expect(screen.getByText('Party chat')).toBeInTheDocument();
  });

  it('an older server with no tableMode keeps Party chat while a device claim waits', () => {
    mount();
    act(() => {
      hoisted.onMessage!({
        seq: 1,
        type: 'SeatClaimRequested',
        payload: {
          claimId: 'claim-1',
          seatId: 'seat-self',
          displayName: 'Cy',
          expiresAt: Date.now() + 60_000,
        },
      } as ServerMessage);
    });
    expect(screen.getByText('Party chat')).toBeInTheDocument();
  });
});
