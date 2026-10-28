// @vitest-environment jsdom
import { Profiler } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Battlemap, ServerMessage } from '@game/schema';
import { Game } from '../src/screens/Game.js';
import { gameStore } from '../src/state/store.js';
import { initialGameState } from '../src/state/gameStore.js';
import { http } from '../src/api.js';

const hoisted = vi.hoisted(() => ({
  send: vi.fn((): string | boolean => true),
  onMessage: undefined as ((m: ServerMessage) => void) | undefined,
  room: undefined as unknown,
  account: { id: 'acct-1' },
  privateRoundSubmission: undefined as
    | { roundId: string; actionId: string; text: string; queued: boolean }
    | undefined,
}));
vi.mock('../src/room/useRoom.js', () => ({
  useRoom: (opts: { onMessage: (m: ServerMessage) => void }) => {
    hoisted.onMessage = opts.onMessage;
    return {
      room: hoisted.room,
      status: 'connected',
      send: hoisted.send,
      privateRoundSubmission: hoisted.privateRoundSubmission,
    };
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
  // the server rotates the list so the active entity is first
  activeEntityId: order[0] ?? null,
  initiative: order.map((entityId, i) => ({ entityId, total: 20 - i })),
  resources,
  entities,
});
let seq = 0;
const push = (type: string, payload: Record<string, unknown>) =>
  act(() => {
    hoisted.onMessage!({ seq: ++seq, type, payload } as ServerMessage);
  });

function mount(onRender?: () => void) {
  hoisted.room = {
    gameState: {
      characters: { 'acct-1': hero },
      combatRoom: { entities, map },
    },
  };
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <Profiler id="game-opening" onRender={onRender ?? (() => {})}>
              <Game />
            </Profiler>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Game screen (live Room)', () => {
  beforeEach(() => {
    hoisted.privateRoundSubmission = undefined;
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

  it('skip link focuses the action textarea; composer precedes map controls in tab order', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    const skip = screen.getByRole('link', { name: 'Skip to your action' });
    const firstFocusable = document
      .querySelector('.game-screen')!
      .querySelector('a[href], button, textarea, input, [tabindex="0"]');
    expect(firstFocusable).toBe(skip);
    await user.click(skip);
    expect(screen.getByLabelText('Your action')).toHaveFocus();
    await user.click(screen.getByRole('link', { name: 'Skip to story' }));
    expect(document.getElementById('game-story')).toHaveFocus();
    const textarea = screen.getByLabelText('Your action');
    const endTurn = screen.getByRole('button', { name: 'End turn' });
    expect(
      textarea.compareDocumentPosition(endTurn) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('never commits the opening placeholder while non-empty history is being restored', () => {
    const openingVisibilityByCommit: boolean[] = [];
    mount(() => {
      openingVisibilityByCommit.push(
        Boolean(document.querySelector('.narration-log__opening')),
      );
    });

    push('StateSync', { state: { openClarifications: {} } });
    push('NarrationHistory', {
      turns: [
        {
          turnId: 'restored-opening',
          text: 'The restored story is ready.',
          tier: 'standard',
        },
      ],
    });

    expect(openingVisibilityByCommit.length).toBeGreaterThan(1);
    expect(openingVisibilityByCommit).not.toContain(true);
    expect(
      screen.getByText('The restored story is ready.'),
    ).toBeInTheDocument();
  });

  it('shows the opening after the real synchronization fallback, then hides it when history arrives', () => {
    vi.useFakeTimers();
    try {
      mount();
      push('StateSync', { state: { openClarifications: {} } });
      expect(
        screen.queryByRole('heading', { name: 'The adventure begins' }),
      ).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(
        screen.getByRole('heading', { name: 'The adventure begins' }),
      ).toBeInTheDocument();

      push('NarrationHistory', {
        turns: [
          {
            turnId: 'late-opening',
            text: 'The late restored story is ready.',
            tier: 'standard',
          },
        ],
      });
      expect(
        screen.queryByRole('heading', { name: 'The adventure begins' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText('The late restored story is ready.'),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds the opening placeholder between StateSync and restored narration history', () => {
    mount();
    push('StateSync', { state: { openClarifications: {} } });
    expect(
      screen.queryByRole('heading', { name: 'The adventure begins' }),
    ).not.toBeInTheDocument();

    push('NarrationHistory', {
      turns: [
        {
          turnId: 'restored-opening',
          text: 'The restored story is ready.',
          tier: 'standard',
        },
      ],
    });
    expect(
      screen.getByText('The restored story is ready.'),
    ).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Attack Goblin' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'attack',
      targetId: 'ent_goblin',
      attackId: 'staff',
    });
    // The label is 1-based like the keyboard announcements; the wire destination stays 0-based.
    await user.click(screen.getByRole('button', { name: /Move to 3, 3/ }));
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'move',
      destination: { x: 2, y: 2 },
    });
  });

  it('CombatEnded clears the combat bar, threat line and stale attacks, then Continue returns to exploration', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a',
          targetId: 'ent_goblin',
          attackId: 'equipment:javelin',
        },
        { kind: 'move', optionId: 'm', destination: { x: 2, y: 2 }, cost: 5 },
      ],
    });
    expect(
      screen.getByRole('button', { name: 'Attack Goblin' }),
    ).toBeInTheDocument();

    push('CombatEnded', { outcome: 'party-victory' });

    expect(
      within(screen.getByRole('region', { name: 'Combat result' })).getByRole(
        'status',
      ),
    ).toHaveTextContent('Victory');
    expect(
      screen.queryByRole('button', { name: 'Attack Goblin' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Move to / }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'End turn' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Threats within 30 feet/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/CombatEnded:/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      screen.queryByRole('region', { name: 'Combat result' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue' }),
    ).not.toBeInTheDocument();
  });

  it('a room-state refresh after CombatEnded keeps the result card on screen', () => {
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    push('CombatEnded', { outcome: 'party-victory' });
    // A reconnect refetches room state; the combat snapshot there carries no ended field.
    hoisted.room = {
      gameState: {
        characters: { 'acct-1': hero },
        combatRoom: {
          entities,
          map,
          combat: { round: 1, activeEntityId: null, initiative: [] },
        },
      },
    };
    push('CombatOptions', { actions: [] });

    expect(
      screen.getByRole('region', { name: 'Combat result' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Combat commands' }),
    ).not.toBeInTheDocument();
  });

  it('area aim: an aim previews its affected units and Cast sends the option ref', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', tracker(['ent_goblin', HERO_ID]));
    push('CombatOptions', {
      actions: [],
      areas: [
        {
          spellId: 'spell:burning-hands',
          optionId: 'area:burning-hands:2,2:1,0',
          anchor: { x: 2, y: 2 },
          direction: { x: 1, y: 0 },
          cells: [{ x: 2, y: 2 }],
          affected: [{ id: 'ent_goblin', relation: 'enemy' }],
        },
      ],
    });
    await user.click(
      screen.getByRole('radio', {
        name: /burning hands at 3, 3, facing east; 1 affected/,
      }),
    );
    expect(screen.getByText('1 affected: Goblin (enemy).')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cast area' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'cast',
      spellId: 'spell:burning-hands',
      slotLevel: 1,
      target: { kind: 'option', ref: 'area:burning-hands:2,2:1,0' },
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

  it('a turn failure for another seat leaves this seat queued and offers no retry', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ActionQueued', { actionId: 'mine-1' });
    push('Error', {
      code: 'TURN_FAILED',
      message: 'The DM could not complete that turn. You can try again.',
      actionId: 'their-action',
    });
    expect(screen.getByText('Queued: I search the room.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your action')).toHaveValue('');
    expect(
      screen.queryByRole('button', { name: 'Retry this action' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'The DM could not complete that turn. You can try again.',
      ),
    ).not.toBeInTheDocument();
  });

  it('a turn failure for this seat restores its text and offers Retry', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ActionQueued', { actionId: 'mine-1' });
    push('Error', {
      code: 'TURN_FAILED',
      message: 'The DM could not complete that turn. You can try again.',
      actionId: 'mine-1',
    });
    expect(
      screen.queryByText('Queued: I search the room.'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your action')).toHaveValue(
      'I search the room.',
    );
    await user.click(screen.getByRole('button', { name: 'Retry this action' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('PlayerAction', {
      text: 'I search the room.',
    });
  });

  it('a round failure restores only the seat whose submission was in that round', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    hoisted.privateRoundSubmission = {
      roundId: 'round-7',
      actionId: 'mine-1',
      text: 'I search the room.',
      queued: true,
    };
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('Error', {
      code: 'TURN_FAILED',
      message: 'The DM could not complete that round. Try again.',
      actionId: 'round-9',
    });
    expect(screen.getByText('Queued: I search the room.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry this action' }),
    ).not.toBeInTheDocument();
    // The server resolves the round (clearing the private submission) before its turn can fail.
    hoisted.privateRoundSubmission = undefined;
    push('RoundResolved', {
      roundId: 'round-7',
      closeReason: 'all-submitted',
      actions: [],
    });
    push('Error', {
      code: 'TURN_FAILED',
      message: 'The DM could not complete that round. Try again.',
      actionId: 'round-7',
    });
    expect(
      screen.queryByText('Queued: I search the room.'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your action')).toHaveValue(
      'I search the room.',
    );
    expect(
      screen.getByRole('button', { name: 'Retry this action' }),
    ).toBeInTheDocument();
    hoisted.privateRoundSubmission = undefined;
  });

  it('a round-path restriction for a seat that is not restricted shows the generic failure with Retry', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    hoisted.privateRoundSubmission = {
      roundId: 'round-7',
      actionId: 'mine-1',
      text: 'I search the room.',
      queued: true,
    };
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    // The server broadcasts the round's restriction to every seat; it names the round, not this seat's action.
    push('Error', {
      code: 'LIVE_DM_RESTRICTED',
      message: 'Live DM is not enabled for this account.',
      actionId: 'round-7',
    });
    expect(
      screen.getByText('The DM could not complete that turn.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Live DM is not enabled for this account.'),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your action')).toHaveValue(
      'I search the room.',
    );
    await user.click(screen.getByRole('button', { name: 'Retry this action' }));
    expect(hoisted.send).toHaveBeenLastCalledWith('PlayerAction', {
      text: 'I search the room.',
    });
    hoisted.privateRoundSubmission = undefined;
  });

  it('a single-action restriction for this seat keeps the restricted copy and no Retry', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(screen.getByLabelText('Your action'), 'I search the room.');
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ActionQueued', { actionId: 'mine-1' });
    push('Error', {
      code: 'LIVE_DM_RESTRICTED',
      message: 'Live DM is not enabled for this account.',
      actionId: 'mine-1',
    });
    expect(
      screen.getByText('Live DM is not enabled for this account.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry this action' }),
    ).not.toBeInTheDocument();
  });

  it('shows a clarifying question only to the seat whose own action it asks about', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(
      screen.getByLabelText('Your action'),
      'I ask the innkeeper.',
    );
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ClarificationRequested', {
      actionId: 'their-action',
      question: 'Which door?',
    });
    expect(
      screen.queryByRole('form', { name: 'Reply to clarifying question' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Which door?')).not.toBeInTheDocument();
    push('ClarificationRequested', {
      actionId: 'mine-1',
      question: 'Which door?',
    });
    expect(
      screen.getByRole('form', { name: 'Reply to clarifying question' }),
    ).toHaveTextContent('Which door?');
  });

  it('a state sync leaves the owner reply prompt open', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(
      screen.getByLabelText('Your action'),
      'I ask the innkeeper.',
    );
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ClarificationRequested', {
      actionId: 'mine-1',
      question: 'Which door?',
    });
    push('StateSync', { state: { openClarifications: {} } });
    expect(
      screen.getByRole('form', { name: 'Reply to clarifying question' }),
    ).toHaveTextContent('Which door?');
  });

  it('the owner answers the prompt, and an error for that action ends it', async () => {
    const user = userEvent.setup();
    hoisted.send.mockReturnValueOnce('mine-1');
    mount();
    await user.type(
      screen.getByLabelText('Your action'),
      'I ask the innkeeper.',
    );
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ClarificationRequested', {
      actionId: 'mine-1',
      question: 'Which door?',
    });
    await user.type(screen.getByLabelText('Your reply'), 'The red one.');
    await user.click(
      screen.getByRole('button', { name: 'Reply to this action' }),
    );
    expect(hoisted.send).toHaveBeenLastCalledWith('ClarificationAnswer', {
      actionId: 'mine-1',
      answer: 'The red one.',
    });
    expect(
      screen.queryByRole('form', { name: 'Reply to clarifying question' }),
    ).not.toBeInTheDocument();
    push('ClarificationRequested', {
      actionId: 'mine-1',
      question: 'Which door?',
    });
    push('Error', {
      code: 'TURN_FAILED',
      message: 'Turn failed.',
      actionId: 'mine-1',
    });
    expect(
      screen.queryByRole('form', { name: 'Reply to clarifying question' }),
    ).not.toBeInTheDocument();
  });

  it('keeps report action and rewind banner available in the live story log', async () => {
    const user = userEvent.setup();
    mount();
    push('NarrationCompleted', {
      actionId: 'server-action-1',
      turnId: 'turn-1',
      text: 'A sealed door opens.',
    });
    const report = screen.getByRole('button', { name: 'Report this message' });
    report.focus();
    await user.keyboard('{Enter}');
    expect(
      screen.getByRole('form', { name: 'Report message' }),
    ).toBeInTheDocument();
    push('TurnReverted', { revertedTurnId: 'turn-1' });
    const banner = screen.getByText(/The host rewound the last DM turn/i);
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveTextContent(/host rewound the last DM turn/i);
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
    // Tokens show the derived display name, never the raw id.
    expect(active[0]!.textContent).toContain('Goblin');
    expect(active[0]!.textContent).not.toContain('ent_goblin');
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
    ).toContain('Aria');
  });

  it('shows no active token and says so while a creature hidden from this viewer acts', () => {
    mount();
    push('CombatTracker', {
      ...tracker([HERO_ID, 'ent_goblin']),
      activeEntityId: null,
    });
    const items = within(
      screen.getByRole('list', { name: 'Initiative tracker' }),
    ).getAllByRole('listitem');
    for (const item of items) {
      expect(item).not.toHaveAttribute('aria-current');
      expect(item.textContent).not.toContain('(active)');
    }
    const tokens = within(
      screen.getByRole('list', { name: 'Combat tokens' }),
    ).getAllByRole('listitem');
    expect(
      tokens.filter((t) => t.getAttribute('data-active') === 'true'),
    ).toHaveLength(0);
    expect(
      screen.getByText('An unseen creature is acting.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Active combatant:/)).toBeNull();
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
        `Aria: 30 feet movement remaining\\. Threats within 30 feet: `,
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
    ).toMatch(/Goblin: /);
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
    // A click on the canvas is a shortcut into the same keyboard-reachable move preview; pointerdown and drag stay absent.
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

  it('gives a non-controlling seat a status notice only, never Accept/Decline controls', () => {
    mount();
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    push('ReactionPromptOpen', {
      reactionId: 'r-open',
      reactorEntityId: 'ent_goblin',
      deadlineAt: new Date(Date.now() + 5000).toISOString(),
      timeoutMs: 5000,
    });
    expect(
      screen.getByText(/Reaction window open for Goblin/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Accept' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Decline' }),
    ).not.toBeInTheDocument();
  });

  it('gives the controlling reactor the decision dialog from ReactionPrompt', () => {
    mount();
    push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    push('ReactionPrompt', {
      reactionId: 'r-own',
      entityId: 'ent_goblin',
      moverId: HERO_ID,
      trigger: 'opportunityAttack',
      options: ['take', 'decline'],
      defaultChoice: 'decline',
      timeoutMs: 5000,
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });
});

describe('Game screen layout', () => {
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

  it('before combat: map placeholder explains how a fight starts; safety is a toolbar, panels are collapsed drawers; no nested main', async () => {
    const { container } = mount();
    expect(
      await screen.findByText(/Combat starts when a fight breaks out/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Safety controls' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /X-card/ })).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Narration log' })).toBeVisible();
    // The app shell owns the <main> landmark; the game screen must not add a second one.
    expect(container.querySelector('main')).toBeNull();
    for (const drawer of container.querySelectorAll('details.drawer'))
      expect(drawer).not.toHaveAttribute('open');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('in combat: the tracker and the map replace the placeholder, and axe stays clean', async () => {
    const { container } = mount();
    await screen.findByText(/Combat starts when a fight breaks out/);
    await push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
    expect(
      screen.queryByText(/Combat starts when a fight breaks out/),
    ).toBeNull();
    expect(
      screen.getByRole('list', { name: 'Initiative tracker' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('application', { name: 'Battle map' }),
    ).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('Game screen narrow viewport', () => {
  const stubNarrow = () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    return () => {
      window.matchMedia = original;
    };
  };

  it('starts in list-driven combat, opens the map on request, and keeps reactions operable', async () => {
    const restore = stubNarrow();
    try {
      const user = userEvent.setup();
      const { container } = mount();
      push('CombatTracker', tracker([HERO_ID, 'ent_goblin']));
      expect(container.querySelector('canvas')).toBeNull();
      expect(
        screen.getByRole('list', { name: 'Combat tokens' }),
      ).toBeInTheDocument();
      const toggle = screen.getByRole('button', { name: 'Show map' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      expect(container.querySelector('canvas')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Hide map' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );

      await user.click(screen.getByRole('button', { name: 'Hide map' }));
      expect(container.querySelector('canvas')).toBeNull();

      push('ReactionPrompt', {
        reactionId: 'r1',
        entityId: 'ent_goblin',
        moverId: HERO_ID,
        trigger: 'leaves reach',
        timeoutMs: 15000,
      });
      expect(
        await screen.findByRole('dialog', { name: 'Opportunity attack' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Decline' }),
      ).toBeInTheDocument();
    } finally {
      restore();
    }
  });
});

describe('Combat bar stays current (options, move shortcut, clarification placement)', () => {
  const trackerAt = (heroPos: { x: number; y: number }, movement: number) => ({
    round: 1,
    activeEntityId: HERO_ID,
    initiative: [HERO_ID, 'ent_goblin'].map((entityId, i) => ({
      entityId,
      total: 20 - i,
    })),
    resources: {
      ...resources,
      [HERO_ID]: { ...resources[HERO_ID], movementRemaining: movement },
    },
    entities: entities.map((entity) =>
      entity.id === HERO_ID ? { ...entity, pos: heroPos } : entity,
    ),
  });

  beforeEach(() => {
    hoisted.privateRoundSubmission = undefined;
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

  it('requests combat options when this seat turn starts, with no manual refresh', () => {
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    expect(hoisted.send).toHaveBeenCalledWith('CombatCommand', {
      command: 'options',
    });
  });

  it('refetches options after the seat moves, so Attack appears once the target is in reach', () => {
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        {
          kind: 'move',
          optionId: 'm1',
          destination: { x: 2, y: 2 },
          cost: 5,
        },
      ],
    });
    expect(
      screen.queryByRole('button', { name: 'Attack Goblin' }),
    ).not.toBeInTheDocument();

    hoisted.send.mockClear();
    push('CombatTracker', trackerAt({ x: 4, y: 2 }, 25));
    expect(hoisted.send).toHaveBeenCalledWith('CombatCommand', {
      command: 'options',
    });
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    expect(
      screen.getByRole('button', { name: 'Attack Goblin' }),
    ).toBeInTheDocument();
  });

  it('drops the options list when the turn passes to someone else', () => {
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        {
          kind: 'attack',
          optionId: 'a1',
          targetId: 'ent_goblin',
          attackId: 'staff',
        },
      ],
    });
    push('CombatTracker', {
      ...trackerAt({ x: 1, y: 2 }, 0),
      activeEntityId: 'ent_goblin',
    });
    expect(
      screen.queryByRole('button', { name: 'Attack Goblin' }),
    ).not.toBeInTheDocument();
  });

  it('offers Move toward a target that moves the seat to the reachable cell nearest it', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    push('CombatOptions', {
      actions: [
        { kind: 'move', optionId: 'm1', destination: { x: 2, y: 2 }, cost: 5 },
        { kind: 'move', optionId: 'm2', destination: { x: 3, y: 2 }, cost: 10 },
        { kind: 'move', optionId: 'm3', destination: { x: 4, y: 2 }, cost: 15 },
        { kind: 'move', optionId: 'm4', destination: { x: 1, y: 3 }, cost: 5 },
      ],
    });
    await user.click(
      screen.getByRole('button', { name: 'Move toward Goblin' }),
    );
    expect(hoisted.send).toHaveBeenLastCalledWith('CombatCommand', {
      command: 'move',
      destination: { x: 4, y: 2 },
    });
  });

  it('a clarifying question sits inline in the story, outside the sticky composer and the combat bar', async () => {
    const user = userEvent.setup();
    mount();
    push('CombatTracker', trackerAt({ x: 1, y: 2 }, 30));
    hoisted.send.mockReturnValueOnce('mine-1');
    await user.type(
      screen.getByLabelText('Your action'),
      'I ask the innkeeper.',
    );
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    push('ClarificationRequested', {
      actionId: 'mine-1',
      question: 'Which door?',
    });
    const form = screen.getByRole('form', {
      name: 'Reply to clarifying question',
    });
    expect(form.closest('.game-area--dock')).toBeNull();
    expect(form.closest('.game-area--story')).not.toBeNull();
    expect(form.closest('details')).not.toBeNull();
    // Keyboard order: the reply comes before the composer, and the combat bar follows it.
    const composer = screen.getByLabelText('Your action');
    expect(
      form.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const endTurn = screen.getByRole('button', { name: 'End turn' });
    expect(
      form.compareDocumentPosition(endTurn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
