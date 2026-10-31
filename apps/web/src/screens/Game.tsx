import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { useRef } from 'react';
import type { Battlemap, ServerMessage } from '@game/schema';
import type { ChatHistoryEntry } from '@game/schema';
import { distance, type Placed } from '@game/rules-engine';
import {
  BattlemapSchema,
  CharacterSchema,
  EngineEventSchema,
} from '@game/schema';
import { Canvas2DRenderer } from '../features/map/Canvas2DRenderer.js';
import { hitTestCell } from '../features/map/hitTest.js';
import { DEFAULT_VIEWPORT } from '../features/map/viewport.js';
import { createTokenDrawCommands } from '../features/map/tokens.js';
import { MapKeyboard } from '../features/map/keyboard.js';
import { TokenTable } from '../features/map/TokenTable.js';
import { createEntityNamer } from '../features/map/names.js';
import { TurnBanner } from '../features/game/TurnBanner.js';
import { Describe } from '../features/map/Describe.js';
import { AreaAim, type AreaOption } from '../features/map/AreaAim.js';
import { CombatEndCard } from '../features/combat/CombatEndCard.js';
import {
  attackRecordFor,
  retainAttackRecord,
} from '../features/combat/attackRecord.js';
import { NarrationLog } from '../features/narration/NarrationLog.js';
import {
  isTurnFailure,
  turnFailureNotice,
} from '../features/narration/logState.js';
import { ActionInput } from '../features/input/ActionInput.js';
import { useDockHeight } from '../features/input/useDockHeight.js';
import { ClarificationReply } from '../features/input/ClarificationReply.js';
import { pendingInputFor } from '../features/input/pendingInput.js';
import { RoundPanel, isOwnSubmission } from '../features/round/RoundPanel.js';
import { HostControls } from '../features/round/HostControls.js';
import { TurnTimerControl } from '../features/round/TurnTimerControl.js';
import { Sheet } from '../features/character/Sheet.js';
import { useSheetLoadFailure } from '../features/character/useSheetLoadFailure.js';
import { ConnectionStatus } from '../room/ConnectionStatus.js';
import { RoomWaitState } from '../room/RoomWaitState.js';
import { useRoom } from '../room/useRoom.js';
import { useRoomStateFailure } from '../room/useRoomStateFailure.js';
import { api, http } from '../api.js';
import { gameStore } from '../state/store.js';
import { weaponName } from '../features/narration/combatRolls.js';
import { ChatPanel } from '../features/chat/ChatPanel.js';
import { Drawer } from '../features/game/Drawer.js';
import '../styles/game.css';

const renderer = new Canvas2DRenderer();
const NARROW_QUERY = '(max-width: 760px)';

/** Narrow screens start in list-driven combat; the canvas is opt-in. */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
type Tracker = NonNullable<ReturnType<typeof gameStore.getState>['tracker']>;
type Entity = {
  id: string;
  kind: 'character' | 'monster' | 'npc';
  name?: string;
  team: string;
  pos: { x: number; y: number };
  size: number;
  hp: number;
  hpState?: string;
  fled?: boolean;
};
type Reaction = {
  reactionId: string;
  entityId: string;
  moverId: string;
  trigger: string;
  timeoutMs: number;
};
type ReactionNotice = {
  reactionId: string;
  entityId: string;
  timeoutMs: number;
};
type PendingAction = {
  id: string;
  text: string;
  acknowledged: boolean;
  submittedAt: number;
};
/** The server's tracker lists the active combatant first; persisted state keeps a fixed order. */
const startAtActive = <T extends { entityId: string }>(
  initiative: T[],
  activeEntityId: unknown,
): T[] => {
  const at = initiative.findIndex((item) => item.entityId === activeEntityId);
  return at > 0
    ? [...initiative.slice(at), ...initiative.slice(0, at)]
    : initiative;
};
/** Server tracker `activeEntityId: null` means a creature hidden from this viewer is acting; only a missing key falls back to the list head. */
const activeOf = (t: {
  activeEntityId?: string | null;
  initiative: { entityId: string }[];
}): string | null =>
  t.activeEntityId === undefined
    ? (t.initiative[0]?.entityId ?? null)
    : t.activeEntityId;
/** Tracker entities are sparse (no size; enemy HP is qualitative): keep what the persisted state already told us. */
const mergeEntities = (previous: Entity[], next: Entity[]): Entity[] =>
  next.map((entity) => {
    const old = previous.find((item) => item.id === entity.id);
    return { ...old, ...entity, size: entity.size ?? old?.size ?? 1 };
  });
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const mergeChatHistory = (
  current: ChatHistoryEntry[],
  incoming: ChatHistoryEntry[],
): ChatHistoryEntry[] => {
  const entries = new Map(
    current.map((entry) => [entry.message.messageId, entry]),
  );
  for (const entry of incoming) entries.set(entry.message.messageId, entry);
  return [...entries.values()].sort((a, b) => a.seq - b.seq);
};

export function Game() {
  const combatRetries = useRef(
    new Map<string, { command: Record<string, unknown>; attempts: number }>(),
  );
  const { id = '' } = useParams();
  // The attack actionIds this seat sent in this game, kept page-wide (see attackRecord.ts) rather than on
  // the 5 s retry timer or this component, so a late rejection still lands on its attack after a remount.
  const attacks = attackRecordFor(id);
  useEffect(() => retainAttackRecord(id), [id]);
  const { account } = useAuth();
  const [resume, setResume] = useState<{
    recap: string;
    name: string;
    premise?: string;
  } | null>(null);
  const [seatClaims, setSeatClaims] = useState<
    {
      claimId: string;
      seatId: string;
      displayName: string;
      expiresAt: number;
    }[]
  >([]);
  const [safetyNotice, setSafetyNotice] = useState('');
  const [spotlightNotice, setSpotlightNotice] = useState('');
  const [resumeError, setResumeError] = useState('');
  const [resumeLoading, setResumeLoading] = useState(false);
  const [historyRestoreCount, setHistoryRestoreCount] = useState(0);
  const [openingSyncTimedOut, setOpeningSyncTimedOut] = useState(false);
  useEffect(() => {
    setOpeningSyncTimedOut(false);
    const timeout = window.setTimeout(
      () => setOpeningSyncTimedOut(true),
      1_500,
    );
    return () => window.clearTimeout(timeout);
  }, [id]);
  const loadGame = () => {
    setResumeLoading(true);
    setResumeError('');
    void api<{ game: { recap: string; name: string; premise?: string } }>(
      `/api/tables/${id}`,
    ).then((result) => {
      if (result.ok) setResume(result.data.game);
      else setResumeError(result.message);
      setResumeLoading(false);
    });
  };
  useEffect(() => {
    if (id) {
      loadGame();
    }
  }, [id]);
  const live = useRoom({
    baseUrl: http.base,
    sessionId: id,
    fetchImpl: (...args) => http.fetch(...args),
    WebSocketImpl: http.WebSocket,
    onMessage: (message) => {
      const isRepeat = messagesRef.current.some(
        (entry) =>
          entry.seq === message.seq &&
          entry.type === message.type &&
          JSON.stringify(entry.payload) === JSON.stringify(message.payload),
      );
      if (!isRepeat) {
        messagesRef.current = [...messagesRef.current, message];
        setMessages(messagesRef.current);
      }
      if (message.type === 'ChatMessage')
        setChatMessages((current) =>
          mergeChatHistory(current, [
            { seq: message.seq, message: message.payload },
          ]),
        );
      if (message.type === 'ChatHistory')
        setChatMessages((current) =>
          mergeChatHistory(current, message.payload.messages),
        );
      if (message.type === 'SeatTakenOver')
        setSafetyNotice('Your seat was recovered on another connection.');
      if (message.type === 'SafetyFlag' && message.payload.kind === 'x-card')
        setSafetyNotice(
          'An X-card was used. The DM will steer away next turn.',
        );
      if (message.type === 'SpotlightPrompt')
        setSpotlightNotice(String(asRecord(message.payload).prompt ?? ''));
      if (message.type === 'SeatClaimRequested') {
        const payload = asRecord(message.payload);
        setSeatClaims((current) => [
          ...current.filter(
            (claim) => claim.claimId !== String(payload.claimId),
          ),
          {
            claimId: String(payload.claimId),
            seatId: String(payload.seatId),
            displayName: String(payload.displayName),
            expiresAt: Number(payload.expiresAt),
          },
        ]);
      }
      if (
        message.type === 'SeatClaimApproved' ||
        message.type === 'SeatClaimDenied' ||
        message.type === 'SeatClaimExpired'
      ) {
        const claimId = String(asRecord(message.payload).claimId ?? '');
        setSeatClaims((current) =>
          current.filter((claim) => claim.claimId !== claimId),
        );
      }
      if (message.type === 'StateSync') {
        live.send('ChatHistoryRequest');
        const state = asRecord(message.payload.state);
        setSafetyNotice((current) =>
          state.paused === true
            ? state.pauseCause === 'no-connected-seats'
              ? 'Table paused: waiting for players to reconnect. It will resume automatically when a seat is confirmed connected.'
              : 'The table is paused.'
            : current.startsWith('Table paused:') ||
                current === 'The table is paused.'
              ? ''
              : current,
        );
      }
      if (message.type === 'NarrationHistory') {
        setHistoryRestoreCount((current) => current + 1);
      }
      if (message.type === 'CombatTracker') {
        // Combat can start after we joined, so the join-time state has no map yet.
        if (!mapRef.current && !resyncAsked.current) {
          resyncAsked.current = true;
          live.send('Resync');
        }
        const payload = asRecord(message.payload);
        setTracker(payload as unknown as Tracker);
        if (Array.isArray(payload.entities))
          setEntities((current) =>
            mergeEntities(current, payload.entities as Entity[]),
          );
      }
      if (message.type === 'CombatEvents') {
        setAttackFeedback(null);
        const events = asRecord(message.payload).events;
        if (Array.isArray(events))
          for (const raw of events) {
            const parsed = EngineEventSchema.safeParse(raw);
            if (!parsed.success) continue;
            const event = parsed.data;
            if (
              event.type === 'ReactionAnswered' ||
              event.type === 'ReactionDeclined'
            ) {
              setReaction(null);
              setReactionNotice(null);
            }
            if (event.type === 'EntityMoved') {
              const last = event.path.at(-1)!;
              setEntities((current) =>
                current.map((entity) =>
                  entity.id === event.entityId
                    ? { ...entity, pos: last }
                    : entity,
                ),
              );
            }
            if (
              event.type === 'HpChanged' ||
              event.type === 'ConditionApplied' ||
              event.type === 'ConditionRemoved' ||
              event.type === 'SlotSpent'
            ) {
              setEntities((current) =>
                current.map((entity) =>
                  entity.id === event.entityId && event.type === 'HpChanged'
                    ? { ...entity, hp: event.hp }
                    : entity,
                ),
              );
              gameStore.applyEvent(event);
            }
          }
      }
      if (message.type === 'ReactionPrompt')
        setReaction(message.payload as Reaction);
      if (message.type === 'ReactionPromptOpen') {
        // Non-controlling seat: only that a window is open and when it ends (ADR-033 §3.1). Never a decision.
        const open = asRecord(message.payload);
        setReactionNotice({
          reactionId: String(open.reactionId),
          entityId: String(open.reactorEntityId),
          timeoutMs: Number(open.timeoutMs),
        });
      }
      if (message.type === 'CombatOptions')
        setOptions(asRecord(message.payload));
      if (message.type === 'CombatEnded') {
        setReaction(null);
        setReactionNotice(null);
        // Options were legal for the fight that just ended; keeping them would offer attacks on dead enemies.
        setOptions(null);
        setTracker((current) =>
          current
            ? {
                ...current,
                ended: asRecord(message.payload) as { outcome: string },
              }
            : current,
        );
      }
      if (message.type === 'ActionQueued' || message.type === 'TurnThinking') {
        const actionId = String(asRecord(message.payload).actionId ?? '');
        if (actionId)
          updatePendingAction((current) =>
            current && !current.acknowledged
              ? { ...current, id: actionId, acknowledged: true }
              : current,
          );
      }
      if (message.type === 'ClarificationRequested') {
        // Broadcast to every seat, but the question belongs to one seat's action: only that seat
        // shows the reply prompt. Other seats ignore it.
        const payload = asRecord(message.payload);
        const actionId = String(payload.actionId ?? '');
        if (pendingActionRef.current?.id === actionId) {
          setClarification({
            actionId,
            question: String(payload.question ?? ''),
          });
          updatePendingAction(() => null);
        }
      }
      if (message.type === 'Error' || message.type === 'NarrationCompleted') {
        // The prompt ends when the action it asked about ends. A state sync never ends it.
        const actionId = String(asRecord(message.payload).actionId ?? '');
        setClarification((current) =>
          current && current.actionId === actionId ? null : current,
        );
      }
      if (message.type === 'NarrationCompleted') {
        const actionId = String(asRecord(message.payload).actionId ?? '');
        updatePendingAction((current) =>
          current && (!actionId || current.id === actionId) ? null : current,
        );
      }
      if (message.type === 'ToolRejected') {
        setError(
          'The DM could not apply part of that action. The rest of the turn may still have succeeded.',
        );
      }
      if (message.type === 'Error') {
        const payload = asRecord(message.payload);
        const actionId = String(payload.actionId ?? '');
        if (payload.code === 'narration-in-progress' && actionId) {
          const pending = combatRetries.current.get(actionId);
          if (pending && pending.attempts < 2) {
            pending.attempts++;
            window.setTimeout(() => {
              if (combatRetries.current.get(actionId) === pending)
                live.send('CombatCommand', pending.command, actionId);
            }, pending.attempts * 150);
            return;
          }
          combatRetries.current.delete(actionId);
        }
        if (payload.code === 'CHAT_REJECTED') {
          setChatError(
            String(payload.message ?? 'That message could not be sent.'),
          );
          return;
        }
        if (isTurnFailure(String(payload.code ?? ''))) {
          // The server broadcasts a turn failure to every seat. Only the seat whose own action
          // failed gets its text back. A round failure names the round, so it also matches when
          // that round is the one this seat submitted into; any other failure leaves this seat alone.
          const mine = pendingActionRef.current;
          const round = submittedRound.current;
          const ownAction = !!mine && actionId === mine.id;
          const viaRound =
            !!mine && round?.actionId === mine.id && actionId === round.roundId;
          if (ownAction || viaRound) {
            updatePendingAction(() => null);
            failedActionText.current = mine.text;
            setActionDraft(mine.text);
            setTurnFailure(
              turnFailureNotice(
                String(payload.code),
                String(
                  payload.message ?? 'The DM could not complete that turn.',
                ),
                viaRound,
              ),
            );
          }
          return;
        }
        // The server uses COMMAND_REJECTED for several attack failures and sends no cause, so the copy stays neutral.
        // Only the newest attack may explain itself; any other attack's rejection, however late, is swallowed.
        if (payload.code === 'COMMAND_REJECTED' && attacks.sent.has(actionId)) {
          combatRetries.current.delete(actionId);
          if (actionId === attacks.latest)
            setAttackFeedback(
              'That attack could not be made. Try another target or action.',
            );
          return;
        }
        setError(String(payload.message ?? 'The command failed.'));
        updatePendingAction((current) =>
          current && (!actionId || current.id === actionId) ? null : current,
        );
      }
    },
  });
  const [messages, setMessages] = useState<ServerMessage[]>([]);
  const messagesRef = useRef<ServerMessage[]>([]);
  const historyMessages = messages.filter(
    (message) => message.type === 'NarrationHistory',
  );
  const hasNarrationTurn = messages.some((message) => {
    if (message.type === 'NarrationHistory')
      return message.payload.turns.length > 0;
    return (
      message.type === 'NarrationChunk' ||
      message.type === 'NarrationCompleted' ||
      message.type === 'ActionQueued' ||
      message.type === 'TurnThinking' ||
      message.type === 'CombatEvents'
    );
  });
  const openingReady = hasNarrationTurn
    ? false
    : (messages.some((message) => message.type === 'StateSync') &&
        historyMessages.length > 0) ||
      openingSyncTimedOut;
  const [chatMessages, setChatMessages] = useState<ChatHistoryEntry[]>([]);
  const [chatError, setChatError] = useState('');
  const [tracker, setTracker] = useState<Tracker | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [map, setMap] = useState<Battlemap | null>(null);
  const mapRef = useRef<Battlemap | null>(null);
  mapRef.current = map;
  const resyncAsked = useRef(false);
  // Only the controlling reactor gets the decision (ReactionPrompt); other seats get a status-only notice.
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [reactionNotice, setReactionNotice] = useState<ReactionNotice | null>(
    null,
  );
  const narrow = useNarrowViewport();
  const [mapShown, setMapShown] = useState(false);
  const mapVisible = !narrow || mapShown;
  const [reactionRemainingMs, setReactionRemainingMs] = useState(0);
  useEffect(() => {
    if (!reaction) {
      setReactionRemainingMs(0);
      return;
    }
    const deadline = Date.now() + reaction.timeoutMs;
    const update = () =>
      setReactionRemainingMs(Math.max(0, deadline - Date.now()));
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [reaction?.reactionId, reaction?.timeoutMs]);
  const [noticeRemainingMs, setNoticeRemainingMs] = useState(0);
  useEffect(() => {
    if (!reactionNotice) {
      setNoticeRemainingMs(0);
      return;
    }
    const deadline = Date.now() + reactionNotice.timeoutMs;
    const update = () =>
      setNoticeRemainingMs(Math.max(0, deadline - Date.now()));
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [reactionNotice?.reactionId, reactionNotice?.timeoutMs]);
  const [options, setOptions] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  // A rejected attack is explained beside the attack buttons, not in the page header.
  const [attackFeedback, setAttackFeedback] = useState<string | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  useDockHeight(dockRef);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const updatePendingAction = (
    update: (current: PendingAction | null) => PendingAction | null,
  ) => {
    const next = update(pendingActionRef.current);
    pendingActionRef.current = next;
    setPendingAction(next);
  };
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [actionDraft, setActionDraft] = useState('');
  const [clarification, setClarification] = useState<{
    actionId: string;
    question: string;
  } | null>(null);
  const room = live.room;
  const selfSeat = room?.seats?.find((seat) => seat.isSelf);
  const hasBoundCharacter =
    live.mySeatId !== null &&
    Boolean(live.boundSeatIds?.includes(live.mySeatId));
  const [sheetRetryAttempt, setSheetRetryAttempt] = useState(0);
  const sheetLoadFailed = useSheetLoadFailure({
    // A bound seat is not served until its sheet arrives, so keep the stall timer running until it does.
    hasCharacterState:
      Boolean(room?.gameState) &&
      (!hasBoundCharacter || Boolean(gameStore.getState().character)),
    connectionStatus: live.status,
    attempt: sheetRetryAttempt,
  });
  const retrySheetConnection = () => {
    setSheetRetryAttempt((attempt) => attempt + 1);
    live.retry();
  };
  const [roomRetryAttempt, setRoomRetryAttempt] = useState(0);
  const roomStateStalled = useRoomStateFailure({
    hasRoom: Boolean(room),
    connectionStatus: live.status,
    attempt: roomRetryAttempt,
  });
  const retryRoomConnection = () => {
    setRoomRetryAttempt((attempt) => attempt + 1);
    live.retry();
  };
  // Reloading mid-turn loses local pending state; the server's private submission restores it.
  const seededAt = useMemo(
    () => Date.now(),
    [live.privateRoundSubmission?.actionId],
  );
  const inputPending = pendingInputFor(
    pendingAction,
    live.privateRoundSubmission,
    seededAt,
  );
  // The server clears the private submission on RoundResolved, before the round's turn runs and
  // can fail. Keep the round this seat submitted into so that failure can still be matched.
  const submittedRound = useRef<{ actionId: string; roundId: string } | null>(
    null,
  );
  useEffect(() => {
    const submission = live.privateRoundSubmission;
    if (submission)
      submittedRound.current = {
        actionId: submission.actionId,
        roundId: submission.roundId,
      };
  }, [live.privateRoundSubmission]);
  useEffect(() => {
    if (!room?.gameState) return;
    const gs = asRecord(room.gameState);
    const combat = asRecord(gs.combatRoom);
    if (Array.isArray(combat.entities))
      setEntities(combat.entities as Entity[]);
    if (combat.map) {
      const parsed = BattlemapSchema.safeParse(combat.map);
      if (parsed.success) setMap(parsed.data);
    }
    const projectedCharacters = asRecord(gs.characters);
    const accountCharacter =
      (selfSeat && projectedCharacters[selfSeat.seatId]) ??
      (account ? projectedCharacters[account.id] : undefined);
    if (accountCharacter) {
      const parsed = CharacterSchema.safeParse(accountCharacter);
      if (parsed.success) gameStore.setCharacter(parsed.data);
    }
    if (combat.combat) {
      const c = asRecord(combat.combat);
      // A room-state refresh after CombatEnded (for example a reconnect) must keep the result on screen.
      const endedFromState = c.ended
        ? (asRecord(c.ended) as { outcome: string })
        : undefined;
      const t = {
        round: Number(c.round ?? 1),
        activeEntityId:
          typeof c.activeEntityId === 'string'
            ? c.activeEntityId
            : c.activeEntityId === null
              ? null
              : ((c.initiative as { entityId?: string }[] | undefined)?.[0]
                  ?.entityId ?? null),
        initiative: Array.isArray(c.initiative)
          ? startAtActive(
              c.initiative as Tracker['initiative'],
              c.activeEntityId,
            )
          : [],
        resources: asRecord(c.resources) as Tracker['resources'],
      };
      setTracker((current) => {
        const ended = endedFromState ?? current?.ended;
        return ended ? { ...t, ended } : t;
      });
      gameStore.setTracker(t);
      gameStore.setCombatState({
        round: t.round,
        turnIndex: 0,
        initiative: t.initiative.map((item, index) => ({
          entityId: item.entityId,
          total: item.total,
          dexterity: 0,
          tieOrder: index,
        })),
        activeEntityId: activeOf(t),
        resources: Object.fromEntries(
          Object.entries(t.resources).map(([entityId, value]) => [
            entityId,
            {
              action: value.action,
              bonusAction: value.bonusAction,
              reaction: value.reaction,
              movementRemaining: value.movementRemaining,
            },
          ]),
        ),
        combatants: Array.isArray(combat.entities)
          ? (combat.entities as Entity[]).map((item) => ({
              id: item.id,
              initiativeModifier: 0,
              speed: 30,
            }))
          : [],
      });
    }
  }, [room, account]);

  const send = (command: Record<string, unknown>) => {
    const actionId = live.send('CombatCommand', command);
    if (command.command === 'attack') {
      attacks.latest = typeof actionId === 'string' ? actionId : null;
      if (typeof actionId === 'string') attacks.sent.add(actionId);
    }
    if (typeof actionId === 'string') {
      const pending = { command, attempts: 0 };
      combatRetries.current.set(actionId, pending);
      window.setTimeout(() => {
        if (combatRetries.current.get(actionId) === pending)
          combatRetries.current.delete(actionId);
      }, 5_000);
    }
    return actionId;
  };
  const lastActionText = useRef('');
  // The text of this player's last turn that failed; Retry resubmits it.
  const failedActionText = useRef('');
  const [turnFailure, setTurnFailure] = useState<{
    message: string;
    canRetry: boolean;
  } | null>(null);
  /** Returns false when the socket refused the action, so the caller keeps its text. */
  const submitAction = (text: string): boolean => {
    // The wire actionId lets the round panel recognise this player's submission.
    const id = live.send('PlayerAction', { text });
    if (!id) {
      setError('Not connected, so your action was not sent. Try again.');
      return false;
    }
    lastActionText.current = text;
    setTurnFailure(null);
    setError('');
    updatePendingAction(() => ({
      id,
      text,
      acknowledged: false,
      submittedAt: Date.now(),
    }));
    setMessages((current) => [
      ...current,
      {
        seq: Date.now(),
        type: 'ActionQueued',
        payload: { actionId: id },
      } as ServerMessage,
    ]);
    return true;
  };
  const characters = asRecord(asRecord(room?.gameState).characters) as Record<
    string,
    { id?: string; name?: string; hp?: { max?: number } } | undefined
  >;
  // Only the viewer's own sheet carries a max HP the viewer may see. Other seats' PCs and monsters get no max here,
  // so their tokens show current HP (when the wire sends it) or the status word.
  const maxHpOf = (entityId: string): number | undefined => {
    const own = gameStore.getState().character;
    return own?.id === entityId ? own.hp.max : undefined;
  };
  const nameOf = useMemo(
    () =>
      createEntityNamer({
        entities,
        seats: room?.seats,
        characters,
      }),
    // `characters` is rebuilt from room state each render; room is the real dependency.
    [entities, room],
  );
  const tokenCommands = useMemo(
    () =>
      tracker
        ? createTokenDrawCommands(
            {
              round: tracker.round,
              turnIndex: 0,
              activeEntityId: activeOf(tracker),
              initiative: tracker.initiative,
              resources: Object.fromEntries(
                Object.entries(tracker.resources).map(([key, value]) => [
                  key,
                  {
                    action: value.action,
                    bonusAction: value.bonusAction,
                    reaction: value.reaction,
                    movementLeft: value.movementRemaining,
                  },
                ]),
              ),
              entities: entities.map(
                ({ id: entityId, kind, pos, size, hp }) => ({
                  id: entityId,
                  kind,
                  pos,
                  size,
                  hp,
                }),
              ),
            },
            Object.fromEntries(
              entities.map((item) => [
                item.id,
                {
                  team: item.team,
                  name: nameOf(item.id),
                  maxHp: maxHpOf(item.id),
                  hpState: item.hpState,
                },
              ]),
            ),
          )
        : [],
    [tracker, entities, nameOf, room],
  );
  const trackerFirst = tracker ? activeOf(tracker) : null;
  const active = trackerFirst;
  // Once CombatEnded arrives the combat bar, threat line and initiative leave the screen; only the result remains.
  const combatOver = Boolean(tracker?.ended);
  const describedTracker =
    tracker && !combatOver
      ? { ...tracker, activeEntityId: trackerFirst }
      : null;
  useEffect(() => {
    if (tracker)
      gameStore.setCombatState({
        ...gameStore.getState().combat,
        initiative: tracker.initiative.map((item, index) => ({
          ...item,
          dexterity: 0,
          tieOrder: index,
        })),
        activeEntityId: combatOver ? null : activeOf(tracker),
        round: tracker.round,
        resources: Object.fromEntries(
          Object.entries(tracker.resources).map(([entityId, value]) => [
            entityId,
            {
              action: value.action,
              bonusAction: value.bonusAction,
              reaction: value.reaction,
              movementRemaining: value.movementRemaining,
            },
          ]),
        ),
      });
  }, [tracker]);
  useEffect(() => {
    gameStore.setTracker(describedTracker);
    gameStore.setBattlemap(map);
    gameStore.setMapEntities(entities.map((item) => ({ ...item, speed: 30 })));
  }, [describedTracker, map, entities]);
  const canvasCommands = map ? renderer.render(map, { cellSize: 32 }) : [];
  const canvasSize = map
    ? { width: map.w * 32, height: map.h * 32 }
    : { width: 0, height: 0 };

  // Host status comes from the shared seat flag, so only the real host sees enabled host controls.
  const isHost = selfSeat?.isHost === true;
  const activeEntity = entities.find((item) => item.id === active);
  const selfCharacterId = selfSeat
    ? (characters[selfSeat.seatId]?.id ??
      (account ? characters[account.id]?.id : undefined))
    : account
      ? characters[account.id]?.id
      : undefined;
  const yourTurn = Boolean(
    active &&
      (active === selfCharacterId ||
        (selfSeat && active === `ent_seat_${selfSeat.seatId}`)),
  );
  const actions = Array.isArray(asRecord(options).actions)
    ? (asRecord(options).actions as unknown[])
    : [];
  const areas = (
    Array.isArray(asRecord(options).areas)
      ? (asRecord(options).areas as unknown[])
      : []
  ).filter(
    (value): value is AreaOption =>
      typeof asRecord(value).optionId === 'string',
  );
  const answerClarification = (actionId: string, reply: string) => {
    setClarification(null);
    setError('');
    updatePendingAction(() => ({
      id: actionId,
      text: reply,
      acknowledged: true,
      submittedAt: Date.now(),
    }));
    live.send('ClarificationAnswer', { actionId, answer: reply });
  };
  const selfEntityId =
    selfCharacterId ?? (selfSeat ? `ent_seat_${selfSeat.seatId}` : undefined);
  const selfEntity = entities.find((item) => item.id === selfEntityId);
  const selfResources =
    tracker && selfEntityId ? tracker.resources[selfEntityId] : undefined;
  const moveOptions = actions
    .map(asRecord)
    .filter((item) => item.kind === 'move');
  const nonMoveActions = actions.filter(
    (value) => asRecord(value).kind !== 'move',
  );
  // Attack options are de-duplicated by target and weapon; the count per target decides whether to name the weapon.
  const firstAttackIndex = new Set<number>();
  const attackCountByTarget = new Map<string, number>();
  {
    const seen = new Set<string>();
    nonMoveActions.forEach((value, index) => {
      const item = asRecord(value);
      if (item.kind !== 'attack') return;
      const key = `${String(item.targetId)}|${String(item.attackId)}`;
      if (seen.has(key)) return;
      seen.add(key);
      firstAttackIndex.add(index);
      const target = String(item.targetId);
      attackCountByTarget.set(
        target,
        (attackCountByTarget.get(target) ?? 0) + 1,
      );
    });
  }
  // The server answers `options` only when asked, and only on this seat's turn. Ask when the turn starts and
  // whenever a move, attack, or spent resource changes the board, so Attack and Move match the current state.
  const optionsKey = yourTurn
    ? JSON.stringify([
        tracker?.round,
        selfEntity?.pos,
        selfResources,
        entities.map((item) => [item.id, item.pos.x, item.pos.y, item.hp]),
      ])
    : null;
  useEffect(() => {
    if (optionsKey !== null) send({ command: 'options' });
  }, [optionsKey]);
  // Options from an earlier turn are not valid once the turn passes to someone else.
  useEffect(() => {
    if (!yourTurn) setOptions(null);
  }, [yourTurn]);
  // The reachable cell that leaves the seat nearest the target; ties go to the cheaper move.
  const nearestStepTo = (foe: Entity) => {
    if (!selfEntity || !map) return null;
    const rule = map.diagonalRule;
    const here = distance(selfEntity as Placed, foe as Placed, rule);
    let best: {
      destination: { x: number; y: number };
      cost: number;
      feet: number;
    } | null = null;
    for (const option of moveOptions) {
      const destination = {
        x: Number(asRecord(option.destination).x),
        y: Number(asRecord(option.destination).y),
      };
      const feet = distance(
        { pos: destination, size: selfEntity.size } as Placed,
        foe as Placed,
        rule,
      );
      const cost = Number(option.cost);
      if (
        feet < here &&
        (!best || feet < best.feet || (feet === best.feet && cost < best.cost))
      )
        best = { destination, cost, feet };
    }
    return best;
  };
  const foes = selfEntity
    ? entities.filter(
        (item) =>
          item.id !== selfEntity.id &&
          item.team !== selfEntity.team &&
          !item.fled &&
          (typeof item.hp !== 'number' || item.hp > 0),
      )
    : [];
  if (live.removed === 'kicked')
    return (
      <section className="game-notice">
        <h1>Removed from table</h1>
        <p role="alert">
          The host removed you from this table. You can no longer send to it.
        </p>
        <Link to="/rooms">My games</Link>
      </section>
    );
  if (live.removed === 'ended')
    return (
      <section className="game-notice">
        <h1>Table ended</h1>
        <p role="status">The host ended this table.</p>
        <Link to="/rooms">My games</Link>
      </section>
    );
  if (live.unseated)
    return (
      <section className="game-notice">
        <h1>Not seated</h1>
        <p role="status">You&apos;re not seated at this table.</p>
        <button type="button" onClick={live.rejoin}>
          Rejoin
        </button>
        <Link to="/rooms">My games</Link>
      </section>
    );
  if (id && resumeLoading)
    return (
      <section className="game-notice">
        <h1>Game</h1>
        <p role="status" className="loading">
          <span className="spinner" aria-hidden="true" />
          Loading your game and recap…
        </p>
        <div className="skeleton" aria-hidden="true" />
      </section>
    );
  if (id && resumeError)
    return (
      <section className="game-notice">
        <h1>Game unavailable</h1>
        <p role="alert" className="form-error">
          {resumeError}
        </p>
        <button type="button" onClick={loadGame}>
          Retry
        </button>
        <Link to="/rooms">My games</Link>
      </section>
    );
  if (!room)
    return (
      <RoomWaitState
        status={live.status}
        error={live.error}
        stalled={roomStateStalled}
        lobbyHref={`/rooms/${id}`}
        onRetry={live.removed ? undefined : retryRoomConnection}
      />
    );
  return (
    <div className="game-screen">
      <div className="game-skip-links">
        <a
          className="skip-link"
          href="#player-action"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById('player-action')?.focus();
          }}
        >
          Skip to your action
        </a>
        <a
          className="skip-link"
          href="#game-story"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById('game-story')?.focus();
          }}
        >
          Skip to story
        </a>
      </div>
      <header className="game-header">
        <h1>{id ? 'Game' : 'Encounter'}</h1>
        <ConnectionStatus status={live.status} />
        <Link to={`/rooms/${id}`}>Back to lobby</Link>
      </header>
      {(live.status === 'reconnecting' || live.status === 'closed') && (
        <p role="alert">
          The connection to the table dropped. Your game is safe. Actions can be
          sent again once it reconnects.
        </p>
      )}
      <p role="status" aria-live="polite">
        {error}
      </p>
      {isHost && seatClaims.length > 0 && (
        <p role="status" aria-live="polite" className="claim-toast">
          {seatClaims.length === 1
            ? `${seatClaims[0]?.displayName ?? 'A player'} is waiting to confirm a device.`
            : `${seatClaims.length} players are waiting to confirm a device.`}{' '}
          Open Host tools to approve or deny.
        </p>
      )}
      <section aria-label="Safety controls" className="game-safety-controls">
        <h2>Safety controls</h2>
        <p
          role="status"
          aria-live="polite"
          data-state={safetyNotice || room.paused ? 'notice' : 'active'}
        >
          {safetyNotice ||
            (room.paused
              ? room.pauseCause === 'no-connected-seats'
                ? 'Table paused: waiting for players to reconnect. It will resume automatically when a seat is confirmed connected.'
                : 'The table is paused.'
              : 'The table is active.')}
        </p>
        {spotlightNotice && (
          <p role="status" aria-live="polite">
            {spotlightNotice}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            if (live.send('XCard'))
              setSafetyNotice(
                'X-card sent anonymously. The DM will steer away next turn.',
              );
            else
              setError('Not connected, so the X-card was not sent. Try again.');
          }}
          disabled={live.status !== 'connected'}
        >
          X-card (anonymous)
        </button>
        {!room.paused ? (
          <button
            type="button"
            disabled={live.status !== 'connected'}
            onClick={() => {
              if (!live.send('PauseTable', { paused: true }))
                setError(
                  'Not connected, so the table was not paused. Try again.',
                );
            }}
          >
            Pause table
          </button>
        ) : isHost ? (
          <button
            type="button"
            disabled={live.status !== 'connected'}
            onClick={() => {
              if (!live.send('PauseTable', { paused: false }))
                setError(
                  'Not connected, so the table was not resumed. Try again.',
                );
            }}
          >
            Resume table
          </button>
        ) : (
          <p>Only the host can resume the table.</p>
        )}
        <details className="game-safety__more">
          <summary>
            <span>About these controls</span>
          </summary>
          <p>
            Pause stops new narration after the current turn. X-card and pause
            also apply to party chat. No explanation is needed.
          </p>
        </details>
      </section>
      <div className="game-layout" data-combat={tracker ? 'true' : 'false'}>
        {tracker && (
          <div className="game-area game-area--banner">
            <TurnBanner
              round={tracker.round}
              activeName={active ? nameOf(active) : null}
              yourTurn={yourTurn}
              initiative={tracker.initiative.map((item) => ({
                entityId: item.entityId,
                name: nameOf(item.entityId),
                active: item.entityId === trackerFirst,
              }))}
              roundClock={room.roundsEnabled ? room.round : undefined}
              outcome={tracker.ended?.outcome}
            />
          </div>
        )}
        <div
          className="game-area game-area--story"
          id="game-story"
          tabIndex={-1}
        >
          {resume?.recap && (
            <section aria-label="Previously on" className="game-recap">
              <details open={!narrow && !tracker}>
                <summary>
                  <h2>Previously on…</h2>
                </summary>
                <p>{resume.recap}</p>
              </details>
            </section>
          )}
          <NarrationLog
            messages={messages}
            openingReady={openingReady}
            historyRestoreKey={historyRestoreCount}
            onReport={async (messageRef, category, reason) => {
              const result = await api(`/api/rooms/${id}/reports`, {
                messageRef,
                category,
                reason,
              });
              return result.ok ? null : result.message;
            }}
            combatantNames={Object.fromEntries(
              entities.map((entity) => [entity.id, nameOf(entity.id)]),
            )}
            combatants={Object.fromEntries(
              entities.map((entity) => [
                entity.id,
                {
                  kind: (entity.kind === 'character' ? 'pc' : 'monster') as
                    | 'pc'
                    | 'monster',
                  hpState: entity.hpState,
                },
              ]),
            )}
            ownEntityIds={
              new Set(
                [gameStore.getState().character?.id].filter(
                  (id): id is string => id !== undefined,
                ),
              )
            }
            opening={{
              title: 'The adventure begins',
              body:
                resume?.premise ||
                (resume?.name
                  ? `${resume.name} is ready. Choose a quick action below, or describe what your character does, and the DM will take it from there.`
                  : 'Choose a quick action below, or describe what your character does, and the DM will take it from there.'),
            }}
          />
          {clarification && (
            <ClarificationReply
              key={clarification.actionId}
              actionId={clarification.actionId}
              question={clarification.question}
              onReply={answerClarification}
            />
          )}
        </div>
        <div className="game-area game-area--dock" ref={dockRef}>
          <ActionInput
            onSubmit={submitAction}
            pending={Boolean(inputPending)}
            pendingText={inputPending?.text}
            pendingSince={inputPending?.submittedAt}
            queuedForNextRound={
              Boolean(inputPending) &&
              Boolean(
                room?.round?.queuedSubmissions.some((item) =>
                  isOwnSubmission(item, live.privateRoundSubmission?.actionId),
                ),
              )
            }
            onEditPending={() => {
              if (!inputPending) return;
              setActionDraft(inputPending.text);
            }}
            initialText={actionDraft}
            onDraftChange={setActionDraft}
            failure={turnFailure}
            // The server has no retry message: retrying resubmits the failed action as a new one.
            onRetry={() => {
              const text = failedActionText.current;
              if (!text) return;
              // Clear the saved text and box only once the resend is accepted; offline, both stay for another Retry.
              if (!submitAction(text)) return;
              failedActionText.current = '';
              setActionDraft('');
            }}
          />
        </div>
        <div className="game-area game-area--map">
          {!tracker && (
            <div className="game-map__empty">
              <span className="game-map__empty-icon" aria-hidden="true">
                ⚔
              </span>
              <h2>The battle map</h2>
              <p>
                Combat starts when a fight breaks out. Describe the encounter in
                your action.
              </p>
            </div>
          )}
          {map && (
            <section aria-label="Battle map" className="game-map">
              <h2>Battle map</h2>
              <MapKeyboard
                store={gameStore}
                onMove={(destination) => send({ command: 'move', destination })}
                reactionPrompt={reaction}
                onReactionChoice={(reactionId, choice) =>
                  send({ command: 'reaction', reactionId, choice })
                }
                reactionRemainingMs={reaction ? reactionRemainingMs : undefined}
                nameOf={nameOf}
              >
                {(pickCell, mapView) => (
                  <div
                    className="game-map__canvas"
                    aria-label={`Battle map ${map.w} columns by ${map.h} rows; tokens listed below`}
                  >
                    {/* Pointer input is a shortcut only; keyboard users reach the same move flow through MapKeyboard. */}
                    {narrow && (
                      <button
                        type="button"
                        aria-expanded={mapShown}
                        aria-controls="game-map-canvas"
                        onClick={() => setMapShown((shown) => !shown)}
                      >
                        {mapShown ? 'Hide map' : 'Show map'}
                      </button>
                    )}
                    {mapVisible && (
                      <canvas
                        id="game-map-canvas"
                        aria-hidden="true"
                        onClick={(event) => {
                          const rect =
                            event.currentTarget.getBoundingClientRect();
                          const scaleX = event.currentTarget.width / rect.width;
                          const scaleY =
                            event.currentTarget.height / rect.height;
                          const cell = hitTestCell(
                            (event.clientX - rect.left) * scaleX,
                            (event.clientY - rect.top) * scaleY,
                            DEFAULT_VIEWPORT,
                            32,
                            map.w,
                            map.h,
                          );
                          if (cell) pickCell(cell);
                        }}
                        width={canvasSize.width}
                        height={canvasSize.height}
                        ref={(canvas) => {
                          if (canvas)
                            renderer.draw(
                              canvas.getContext('2d')!,
                              map,
                              {
                                cellSize: 32,
                                cursor: mapView.cursor,
                                moving: mapView.moving,
                              },
                              tokenCommands,
                            );
                        }}
                        data-command-count={canvasCommands.length}
                      />
                    )}
                    <ul aria-label="Combat tokens">
                      {tokenCommands.map((token) => (
                        <li
                          key={token.entityId}
                          data-active={token.entityId === trackerFirst}
                          data-x={token.x}
                          data-y={token.y}
                        >
                          {token.teamMarker.shape} {token.name} —{' '}
                          {token.hpLabel}
                          {token.active ? ', active' : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </MapKeyboard>
              <TokenTable
                store={gameStore}
                viewerId={active ?? undefined}
                ownEntityId={gameStore.getState().character?.id}
                nameOf={nameOf}
              />
              <Describe
                store={gameStore}
                viewerId={active ?? undefined}
                nameOf={nameOf}
              />
            </section>
          )}
        </div>
        <div className="game-area game-area--actions">
          {tracker && !combatOver && (
            <section aria-label="Combat commands">
              <h2>Combat actions</h2>
              <button
                type="button"
                onClick={() => send({ command: 'options' })}
              >
                Refresh combat options
              </button>
              {foes.map((foe) => {
                const step = nearestStepTo(foe);
                if (!step) return null;
                return (
                  <button
                    key={`toward-${foe.id}`}
                    type="button"
                    title={`Move to ${step.destination.x + 1}, ${step.destination.y + 1} (${step.cost} feet)`}
                    onClick={() =>
                      send({ command: 'move', destination: step.destination })
                    }
                  >
                    Move toward {nameOf(foe.id)}
                  </button>
                );
              })}
              {attackFeedback && (
                <p role="alert" className="combat-attack-feedback">
                  {attackFeedback}
                </p>
              )}
              {nonMoveActions.map((value, index) => {
                const item = asRecord(value);
                if (item.kind === 'attack') {
                  // The same target and weapon can be offered twice; show it once.
                  if (!firstAttackIndex.has(index)) return null;
                  const targetName = nameOf(String(item.targetId));
                  const weapon =
                    (attackCountByTarget.get(String(item.targetId)) ?? 0) > 1
                      ? weaponName(String(item.attackId ?? ''))
                      : undefined;
                  return (
                    <button
                      key={String(item.optionId ?? index)}
                      type="button"
                      onClick={() => {
                        setAttackFeedback(null);
                        send({
                          command: 'attack',
                          targetId: String(item.targetId),
                          attackId: String(item.attackId),
                        });
                      }}
                    >
                      {weapon
                        ? `Attack ${targetName} with ${weapon}`
                        : `Attack ${targetName}`}
                    </button>
                  );
                }
                if (item.kind === 'spell')
                  return (
                    <button
                      key={String(item.optionId ?? index)}
                      type="button"
                      onClick={() =>
                        send({
                          command: 'cast',
                          spellId: String(item.spellId),
                          slotLevel: 1,
                          target: {
                            kind: 'entity',
                            ref: String(item.targetId),
                          },
                        })
                      }
                    >
                      Cast {String(item.spellId)} on{' '}
                      {nameOf(String(item.targetId))}
                    </button>
                  );
                return null;
              })}
              {moveOptions.length > 0 && (
                <details className="combat-move-picker">
                  <summary>
                    Choose a square to move to ({moveOptions.length})
                  </summary>
                  {moveOptions.map((item, index) => (
                    <button
                      key={String(item.optionId ?? index)}
                      type="button"
                      onClick={() =>
                        send({ command: 'move', destination: item.destination })
                      }
                    >
                      Move to {Number(asRecord(item.destination).x) + 1},{' '}
                      {Number(asRecord(item.destination).y) + 1} (
                      {String(item.cost)} feet)
                    </button>
                  ))}
                </details>
              )}
              {areas.length > 0 && (
                <AreaAim
                  areas={areas}
                  nameOf={nameOf}
                  onCast={(area) =>
                    send({
                      command: 'cast',
                      spellId: area.spellId,
                      slotLevel: 1,
                      target: { kind: 'option', ref: area.optionId },
                    })
                  }
                />
              )}
              <button
                type="button"
                onClick={() => send({ command: 'end-turn' })}
              >
                End turn
              </button>
              {reaction && (
                <p role="status">
                  {nameOf(reaction.entityId)} reaction: {reaction.trigger}.
                  Resolve within {Math.ceil(reactionRemainingMs / 1000)}{' '}
                  seconds.
                </p>
              )}
              {!reaction && reactionNotice && (
                <p role="status">
                  Reaction window open for {nameOf(reactionNotice.entityId)}.
                  Waiting for their response; closes in{' '}
                  {Math.ceil(noticeRemainingMs / 1000)} seconds.
                </p>
              )}
            </section>
          )}
          {combatOver && (
            <CombatEndCard
              outcome={tracker?.ended?.outcome}
              onContinue={() => {
                setTracker(null);
                setOptions(null);
              }}
            />
          )}
          {activeEntity && !combatOver && (
            <p className="game-active" data-entity-id={activeEntity.id}>
              Active combatant: {nameOf(activeEntity.id)}
            </p>
          )}
          {tracker &&
            !combatOver &&
            trackerFirst === null &&
            tracker.activeEntityId === null && (
              <p role="status">An unseen creature is acting.</p>
            )}
        </div>
        <aside
          className="game-area game-area--side"
          aria-label="Character and party"
        >
          <Sheet
            store={gameStore}
            loading={!room?.gameState}
            loadFailed={sheetLoadFailed}
            onRetry={live.removed ? undefined : retrySheetConnection}
            seated={Boolean(selfSeat)}
            isHost={isHost}
            hasBoundCharacter={hasBoundCharacter}
            emptyAction={
              <Link className="sheet-empty__link" to={`/rooms/${id}`}>
                Build or choose a character
              </Link>
            }
          />
          {tracker && !combatOver && (
            <section aria-labelledby="tracker-heading">
              <h2 id="tracker-heading">Round {tracker.round}</h2>
              <ol aria-label="Initiative tracker">
                {tracker.initiative.map((item, index) => (
                  <li
                    key={`${item.entityId}-${index}`}
                    aria-current={
                      item.entityId === trackerFirst ? 'step' : undefined
                    }
                  >
                    <span data-entity-id={item.entityId}>
                      {nameOf(item.entityId)}
                    </span>
                    {item.entityId === trackerFirst ? ' (active)' : ''}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {room.roundsEnabled && (
            <RoundPanel
              round={room.round}
              closeAnnouncement={live.roundCloseAnnouncement}
              seats={room.seats}
              myActionId={live.privateRoundSubmission?.actionId}
              selfSeatId={selfSeat?.seatId}
              myText={
                room.roundsEnabled
                  ? live.privateRoundSubmission?.text
                  : pendingAction?.text
              }
              connected={live.status === 'connected'}
              send={live.send}
              onEdited={(text) =>
                updatePendingAction(
                  (current) => current && { ...current, text },
                )
              }
            />
          )}
          {isHost && (
            <Drawer
              id="host"
              title="Host tools"
              badge={seatClaims.length || undefined}
            >
              <HostControls
                round={room.round}
                roundDurationMs={room.roundDurationMs ?? null}
                connected={live.status === 'connected'}
                paused={room.paused === true}
                pauseCause={room.pauseCause}
                send={live.send}
                seats={room.seats}
                selfSeatId={selfSeat?.seatId}
                lateJoinRequests={room.lateJoinRequests}
              />
              <TurnTimerControl
                turnTimerMs={room.turnTimerMs}
                turnTimeoutAction={room.turnTimeoutAction}
                connected={live.status === 'connected'}
                send={live.send}
              />
              {seatClaims.length > 0 && (
                <section aria-label="Device claims">
                  <h2>Reconnect claims</h2>
                  {seatClaims.map((claim) => (
                    <div key={claim.claimId}>
                      <p>
                        {claim.displayName} needs approval to reconnect on a new
                        device.
                      </p>
                      <button
                        type="button"
                        disabled={live.status !== 'connected'}
                        onClick={() =>
                          live.send('ApproveSeatClaim', {
                            claimId: claim.claimId,
                          })
                        }
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={live.status !== 'connected'}
                        onClick={() =>
                          live.send('DenySeatClaim', { claimId: claim.claimId })
                        }
                      >
                        Deny
                      </button>
                    </div>
                  ))}
                </section>
              )}
            </Drawer>
          )}
          <Drawer
            id="chat"
            title="Party chat"
            badge={chatMessages.length || undefined}
          >
            <ChatPanel
              roomId={id}
              messages={chatMessages}
              room={room}
              isHost={isHost}
              connected={live.status === 'connected'}
              error={chatError}
              onSend={(text) => Boolean(live.send('ChatSend', { text }))}
              onMute={(seatId, muted) =>
                Boolean(live.send('MuteChat', { seatId, muted }))
              }
            />
          </Drawer>
        </aside>
      </div>
    </div>
  );
}
