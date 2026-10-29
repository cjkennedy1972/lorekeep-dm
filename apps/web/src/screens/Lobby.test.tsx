// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Lobby } from './Lobby';

const live = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  rejoin: vi.fn(),
}));

vi.mock('../room/useRoom', () => ({
  useRoom: () => ({ ...live.current, rejoin: live.rejoin, send: vi.fn() }),
}));
vi.mock('../api', () => ({
  api: vi.fn(async () => ({
    ok: true,
    data: { account: { matureOptOut: false }, characters: [] },
  })),
  http: { base: 'http://test', fetch: vi.fn(), WebSocket: undefined },
}));

const ROOM = {
  id: 'room-1',
  name: 'Ashfall Table',
  isHost: false,
  tierCap: null,
  code: null,
};
const SEAT = {
  seatId: 'seat-2',
  displayName: 'Mara',
  presence: 'connected',
  accountId: 'acct-2',
};

function setLive(patch: Record<string, unknown>) {
  live.current = {
    status: 'connected',
    error: null,
    removed: null,
    unseated: false,
    needsResync: false,
    lastSeq: 1,
    privateRoundSubmission: undefined,
    roundCloseAnnouncement: undefined,
    deviceClaim: null,
    mySeatId: 'seat-2',
    boundSeatIds: [],
    room: {
      seats: [SEAT],
      round: undefined,
      roundsEnabled: false,
      roundDurationMs: undefined,
      paused: false,
      gameState: { scene: 'tavern' },
    },
    ...patch,
  };
}

function renderLobby() {
  return render(
    <MemoryRouter
      initialEntries={[{ pathname: '/rooms/room-1', state: { room: ROOM } }]}
    >
      <Routes>
        <Route path="/rooms/:id" element={<Lobby />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Lobby enter-game gate', () => {
  beforeEach(() => {
    live.rejoin.mockReset();
  });
  afterEach(() => cleanup());

  test('Enter game is not a link while the seat is unbound, and explains why', () => {
    setLive({ boundSeatIds: [] });
    renderLobby();
    const button = screen.getByRole('button', { name: 'Enter game' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', 'enter-game-hint');
    expect(
      screen.getByText(/Available once your character is bound/),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Enter game' }),
    ).not.toBeInTheDocument();
  });

  test('Enter game becomes a link once the seat is bound', () => {
    setLive({ boundSeatIds: ['seat-2'] });
    renderLobby();
    expect(screen.getByRole('link', { name: 'Enter game' })).toHaveAttribute(
      'href',
      '/rooms/room-1/game',
    );
  });

  test('a pending device claim shows the second approval stage', () => {
    setLive({
      mySeatId: null,
      deviceClaim: { status: 'pending', expiresAt: Date.now() + 60_000 },
    });
    renderLobby();
    expect(
      screen.getByText(
        'Approved by the host. Waiting for the host to confirm your device.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Enter game' })).toBeDisabled();
  });

  test('an expired claim offers Ask again, which reconnects, then waits out the limiter', async () => {
    setLive({ mySeatId: null, deviceClaim: { status: 'expired' } });
    const view = renderLobby();
    const ask = screen.getByRole('button', { name: 'Ask again' });
    expect(ask).toBeEnabled();

    for (let attempt = 0; attempt < 3; attempt++) {
      await userEvent.click(screen.getByRole('button', { name: 'Ask again' }));
      setLive({ mySeatId: null, deviceClaim: { status: 'expired' } });
      view.rerender(
        <MemoryRouter
          initialEntries={[
            { pathname: '/rooms/room-1', state: { room: ROOM } },
          ]}
        >
          <Routes>
            <Route path="/rooms/:id" element={<Lobby />} />
          </Routes>
        </MemoryRouter>,
      );
    }
    expect(live.rejoin).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/You can ask again in/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeDisabled();
  });

  test('seated but unbound in play says the seat joins at the next round', () => {
    setLive({ boundSeatIds: [] });
    renderLobby();
    expect(
      screen.getByText('You are in. Joining at the start of the next round.'),
    ).toBeVisible();
  });
});
