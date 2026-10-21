import type { createApp } from '../app.js';
import type { Pool } from 'pg';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ClientEnvelopeSchema,
  ChatMessageSchema,
  ChatSendSchema,
  ChatHistoryRequestSchema,
  MuteChatSchema,
  type ActionId,
  CombatCommandSchema,
  PlayerActionSchema,
  ClarificationAnswerSchema,
  WithdrawActionSchema,
  XCardSchema,
  PauseTableSchema,
  RewindTurnSchema,
  type ServerMessage,
} from '@game/schema';
import { authenticateRequest } from '../middleware/auth.js';
import type { RoomRegistry } from '../room/registry.js';
import {
  NotTableHostError,
  RewindRefusedError,
  RoomSeatRequiredError,
} from '../room/Room.js';
import {
  consumeTicket,
  eligibleSession,
  issueTicket,
  validOrigin,
} from './tickets.js';
import { ConnectionRegistry } from './connections.js';
import { ChatPolicy } from '../chat/policy.js';
import { randomUUID } from 'node:crypto';
import {
  currentMemberEventsSql,
  currentMemberSql,
} from '../room/membership.js';

const MAX_BYTES = 10 * 1024;
const CHAT_REJECTION = 'That message could not be sent. Try again.';
const MESSAGE_BUCKET_CAPACITY = 20;
const MESSAGE_REFILL_PER_SECOND = 10;
async function hasCurrentSeat(
  db: Pool,
  accountId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await db.query<{ current: boolean }>(
    `SELECT ${currentMemberSql('$2')} AS current FROM sessions s
      WHERE s.id=$1 AND s.status='active'`,
    [sessionId, accountId],
  );
  return result.rows[0]?.current === true;
}

async function currentSeatId(
  db: Pool,
  accountId: string,
  sessionId: string,
): Promise<string | undefined> {
  const result = await db.query<{ seat_id: string }>(
    `SELECT payload->>'seatId' AS seat_id
       FROM (${currentMemberEventsSql('$1')}) current_seat
      WHERE payload->>'accountId'=$2 ORDER BY seq DESC LIMIT 1`,
    [sessionId, accountId],
  );
  return result.rows[0]?.seat_id;
}
export function consumeMessageToken(
  bucket: { tokens: number; updatedAt: number },
  now = Date.now(),
): boolean {
  bucket.tokens = Math.min(
    MESSAGE_BUCKET_CAPACITY,
    bucket.tokens +
      (Math.max(0, now - bucket.updatedAt) * MESSAGE_REFILL_PER_SECOND) / 1000,
  );
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
export function installGateway(
  app: ReturnType<typeof createApp>,
  db: Pool,
  rooms: RoomRegistry,
  connections: ConnectionRegistry = new ConnectionRegistry(db),
  revalidateMs = 15_000,
): () => Promise<void> {
  const chatPolicy = new ChatPolicy();
  app.post<{ Body?: { sessionId?: string } }>(
    '/api/ws-ticket',
    {
      onRequest: async (request, reply) => {
        const origin = request.headers.origin;
        if (origin && validOrigin(origin, request.headers.host)) return;
        return reply.code(403).send({ error: 'origin' });
      },
    },
    async (request, reply) => {
      const auth = await authenticateRequest(db, request);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });
      const sessionId = request.body?.sessionId;
      if (sessionId && !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(sessionId))
        return reply.code(400).send({ error: 'sessionId' });
      const eligible = await eligibleSession(db, auth.account_id, sessionId);
      if (!eligible) return reply.code(403).send({ error: 'not seated' });
      return {
        ticket: await issueTicket(
          db,
          auth.account_id,
          eligible,
          auth.token_hash,
        ),
      };
    },
  );
  let shuttingDown = false;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BYTES,
    perMessageDeflate: false,
  });
  app.server.on('upgrade', (request, socket, head) => {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const reject = () => ws.close(1008, 'Policy violation');
      if (!validOrigin(request.headers.origin, request.headers.host)) {
        reject();
        return;
      }
      const ticket = url.searchParams.get('ticket');
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      if (!ticket) {
        reject();
        return;
      }
      void (async () => {
        const identity = await consumeTicket(db, ticket, sessionId);
        if (!identity) {
          reject();
          return;
        }
        const eligible = await eligibleSession(
          db,
          identity.accountId,
          identity.sessionId,
        );
        if (!eligible) {
          reject();
          return;
        }
        connections.add(ws, identity.authTokenHash);
        ws.on('close', () => connections.remove(ws));
        // Close the consume->register race: revocation may have landed in between.
        await connections.sweep();
        if (ws.readyState !== WebSocket.OPEN) return;
        let room;
        try {
          room = await rooms.get(identity.sessionId);
        } catch {
          ws.close(1013, 'Room unavailable; retry');
          return;
        }
        // The close handler below is not registered yet; bail so no seat or heartbeat is leaked.
        if (ws.readyState !== WebSocket.OPEN) return;
        let chatDeliveryChain: Promise<unknown> = Promise.resolve();
        const queueChatDelivery = (
          message: ServerMessage,
        ): Promise<boolean> => {
          const delivery = chatDeliveryChain.then(async () => {
            if (
              ws.readyState !== WebSocket.OPEN ||
              !validOrigin(request.headers.origin, request.headers.host) ||
              !(await hasCurrentSeat(
                db,
                identity.accountId,
                identity.sessionId,
              ))
            )
              return false;
            transmit(message);
            return true;
          });
          chatDeliveryChain = delivery.catch(() => false);
          return delivery.catch(() => false);
        };
        const connection = {
          send: (message: ServerMessage) => {
            if (
              message.type === 'ChatMessage' ||
              message.type === 'ChatHistory'
            ) {
              void queueChatDelivery(message);
              return;
            }
            transmit(message);
          },
          close: (code: number, reason: string) => ws.close(code, reason),
        };
        const transmit = (message: ServerMessage) => {
          if (ws.readyState === WebSocket.OPEN) {
            if (ws.bufferedAmount > MAX_BYTES * 4) {
              ws.close(1013, 'Slow consumer');
              return;
            }
            ws.send(JSON.stringify(message));
          }
        };
        const send = connection.send;
        let active = true;
        let alive = true;
        const heartbeat = setInterval(() => {
          if (!alive) {
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
        }, 10_000);
        heartbeat.unref();
        ws.on('pong', () => {
          alive = true;
        });
        ws.on('close', () => {
          active = false;
          clearInterval(heartbeat);
          if (room.isCurrentConnection(identity.accountId, connection)) {
            const task = room.disconnect(identity.accountId).catch(() => {});
            disconnectTasks.add(task);
            void task.finally(() => disconnectTasks.delete(task));
          }
        });
        ws.on('error', () => {});
        // A client may act the moment it receives its first message, which room.join() sends
        // before this handler would otherwise exist; ws drops messages with no listener.
        // Buffer (bounded) until the join has finished, then dispatch in order.
        const early: import('ws').RawData[] = [];
        const gate: { dispatch?: (data: import('ws').RawData) => void } = {};
        ws.on('message', (data) => {
          if (gate.dispatch) {
            gate.dispatch(data);
            return;
          }
          if (early.length >= 32) {
            ws.close(1008, 'Too many messages before join');
            return;
          }
          early.push(data);
        });
        try {
          const name = await db.query<{
            display_name: string;
            mature_opt_out: boolean;
          }>('SELECT display_name, mature_opt_out FROM accounts WHERE id=$1', [
            identity.accountId,
          ]);
          await room.join(
            identity.accountId,
            connection,
            name.rows[0]?.display_name ?? identity.accountId,
            name.rows[0]?.mature_opt_out ?? false,
            -1,
            { requireExistingSeat: true },
          );
          if (!active) {
            await room.disconnect(identity.accountId);
            return;
          }
        } catch (error) {
          clearInterval(heartbeat);
          if (error instanceof RoomSeatRequiredError)
            ws.close(1008, 'Player is not seated at this table');
          else ws.close(1011, 'Join failed');
          return;
        }
        // One chain per socket: messages are handled strictly in arrival order, including the
        // async part of PlayerAction, so two quick actions cannot reach the Room swapped.
        let chain: Promise<unknown> = Promise.resolve();
        let pendingChatMessages = 0;
        const chatDeadlineTimers = new Map<
          import('../room/Room.js').ChatReceipt,
          ReturnType<typeof setTimeout>
        >();
        const chatAbortControllers = new Map<
          import('../room/Room.js').ChatReceipt,
          AbortController
        >();
        const clearChatDeadline = (
          receipt: import('../room/Room.js').ChatReceipt,
        ) => {
          const timer = chatDeadlineTimers.get(receipt);
          if (timer) clearTimeout(timer);
          chatDeadlineTimers.delete(receipt);
        };
        const messageBucket = {
          tokens: MESSAGE_BUCKET_CAPACITY,
          updatedAt: Date.now(),
        };
        const dispatch = (data: import('ws').RawData) => {
          let envelope: unknown;
          try {
            envelope = JSON.parse(data.toString());
          } catch {
            envelope = undefined;
          }
          const chat = ChatSendSchema.safeParse(envelope);
          if (chat.success) {
            const receivedAt = Math.floor(performance.now());
            const receipt = room.registerChatReceipt(receivedAt);
            if (pendingChatMessages >= 2) {
              receipt.decide('queue_full');
              void writeChatGateLog(identity.accountId, identity.sessionId)
                .then((id) => room.rejectChat(receipt, 'queue_full', id))
                .catch(() => receipt.finish());
              send({
                seq: room.seq,
                type: 'Error',
                payload: {
                  code: 'CHAT_REJECTED',
                  message: CHAT_REJECTION,
                  actionId: chat.data.actionId,
                },
              });
              return;
            }
            pendingChatMessages += 1;
            const deadline = setTimeout(
              () => {
                chatDeadlineTimers.delete(receipt);
                if (!receipt.decide('deadline')) return;
                chatAbortControllers.get(receipt)?.abort();
                send({
                  seq: room.seq,
                  type: 'Error',
                  payload: {
                    code: 'CHAT_REJECTED',
                    message: CHAT_REJECTION,
                    actionId: chat.data.actionId,
                  },
                });
                void writeChatGateLog(identity.accountId, identity.sessionId)
                  .then((id) => room.rejectChat(receipt, 'deadline', id))
                  .catch(() => receipt.finish());
              },
              Math.max(0, 10_000 - (performance.now() - receivedAt)),
            );
            deadline.unref?.();
            chatDeadlineTimers.set(receipt, deadline);
            chain = chain
              .then(() => connections.sweepIfStale().catch(() => {}))
              .then(() => {
                if (ws.readyState === WebSocket.OPEN)
                  return handle(data, receipt);
                receipt.finish();
              })
              .catch(() => receipt.finish())
              .finally(() => {
                pendingChatMessages -= 1;
              });
            return;
          }
          // Rate-limit before queueing: a flood must not grow the promise chain.
          if (!consumeMessageToken(messageBucket)) {
            if (ws.readyState === WebSocket.OPEN)
              send({
                seq: room.seq,
                type: 'Error',
                payload: {
                  code: 'RATE_LIMITED',
                  message: 'Too many messages.',
                },
              });
            return;
          }
          chain = chain
            .then(() => connections.sweepIfStale().catch(() => {}))
            .then(() => {
              if (ws.readyState === WebSocket.OPEN) return handle(data);
            })
            .catch(() => {});
        };
        const writeChatGateLog = async (
          accountId: string,
          sessionId: string,
        ): Promise<string | undefined> => {
          try {
            const result = await db.query<{ id: string }>(
              `INSERT INTO moderation_log(surface,account_id,session_id,category,source,expires_at)
               VALUES('chat',$1,$2,'other','rate-limit',now() + interval '30 days') RETURNING id`,
              [accountId, sessionId],
            );
            return result.rows[0]?.id;
          } catch {
            return undefined;
          }
        };
        const sendChatHistory = async (
          messages: import('@game/schema').ChatHistoryEntry[],
        ) => {
          const entries = messages.length ? messages : [undefined];
          for (const entry of entries) {
            if (
              ws.readyState !== WebSocket.OPEN ||
              !validOrigin(request.headers.origin, request.headers.host) ||
              !(await hasCurrentSeat(
                db,
                identity.accountId,
                identity.sessionId,
              ))
            )
              return;
            const message: ServerMessage = {
              seq: room.seq,
              type: 'ChatHistory',
              payload: { messages: entry ? [entry] : [] },
            };
            const frame = JSON.stringify(message);
            if (Buffer.byteLength(frame) > MAX_BYTES) return;
            if (!(await queueChatDelivery(message))) return;
          }
        };
        const handle = (
          data: import('ws').RawData,
          chatReceipt?: import('../room/Room.js').ChatReceipt,
        ) => {
          let parsed;
          try {
            parsed = ClientEnvelopeSchema.safeParse(
              JSON.parse(data.toString()),
            );
          } catch {
            parsed = { success: false } as const;
          }
          if (!parsed.success) {
            send({
              seq: room.seq,
              type: 'Error',
              payload: {
                code: 'INVALID_ENVELOPE',
                message: 'Malformed message',
              },
            });
            return;
          }
          const msg = parsed.data;
          if (msg.type === 'ChatSend') {
            const action = ChatSendSchema.safeParse(msg);
            if (!action.success || !chatReceipt) return;
            return handleChat(action.data, chatReceipt);
          }
          if (msg.type === 'ChatHistoryRequest') {
            const requestMessage = ChatHistoryRequestSchema.safeParse(msg);
            if (!requestMessage.success) return;
            if (!validOrigin(request.headers.origin, request.headers.host)) {
              ws.close(1008, 'Policy violation');
              return;
            }
            return eligibleSession(db, identity.accountId, identity.sessionId)
              .then(async (eligible) => {
                if (
                  eligible !== identity.sessionId ||
                  !(await hasCurrentSeat(
                    db,
                    identity.accountId,
                    identity.sessionId,
                  ))
                )
                  throw new RoomSeatRequiredError();
                const messages = await room.loadChatHistory(identity.accountId);
                await sendChatHistory(messages);
              })
              .catch(() =>
                ws.close(1008, 'Player is not seated at this table'),
              );
          }
          if (msg.type === 'MuteChat') {
            const mute = MuteChatSchema.safeParse(msg);
            if (!mute.success) return;
            return db
              .query<{ host: boolean }>(
                'SELECT owner_account_id=$2 AS host FROM sessions WHERE id=$1',
                [identity.sessionId, identity.accountId],
              )
              .then(async ({ rows }) => {
                if (rows[0]?.host !== true) throw new NotTableHostError();
                const target = room.state.seats.find(
                  (seat) => seat.seatId === mute.data.payload.seatId,
                );
                if (!target) throw new RoomSeatRequiredError();
                if (mute.data.payload.muted)
                  await db.query(
                    `INSERT INTO chat_mutes(session_id,seat_id,muted_until,source,updated_by)
                     VALUES($1,$2,NULL,'host',$3)
                     ON CONFLICT(session_id,seat_id) DO UPDATE SET muted_until=NULL,source='host',updated_at=now(),updated_by=EXCLUDED.updated_by`,
                    [identity.sessionId, target.seatId, identity.accountId],
                  );
                else {
                  chatPolicy.liftMute(identity.sessionId, target.seatId);
                  await db.query(
                    `DELETE FROM chat_mutes WHERE session_id=$1 AND seat_id=$2`,
                    [identity.sessionId, target.seatId],
                  );
                }
              })
              .catch(() =>
                send({
                  seq: room.seq,
                  type: 'Error',
                  payload: {
                    code: 'ACTION_REJECTED',
                    message: 'Chat mute could not be changed.',
                    actionId: msg.actionId,
                  },
                }),
              );
          }
          if (msg.type === 'Resync') {
            void room
              .subscribe(identity.accountId, connection, -1)
              .catch(() => ws.close(1011));
            return;
          }
          if (msg.type === 'CombatCommand') {
            const action = CombatCommandSchema.safeParse(msg);
            if (!action.success) {
              send({
                seq: room.seq,
                type: 'Error',
                payload: {
                  code: 'INVALID_ACTION',
                  message: 'Combat command is invalid.',
                  actionId: msg.actionId,
                },
              });
              return;
            }
            return room
              .submitCombatCommand(
                identity.accountId,
                action.data.actionId,
                action.data.payload,
              )
              .then((accepted) => {
                if (!accepted)
                  send({
                    seq: room.seq,
                    type: 'Error',
                    payload: {
                      code: 'DUPLICATE_ACTION',
                      message: 'This combat command was already received.',
                      actionId: msg.actionId,
                    },
                  });
              })
              .catch(() =>
                send({
                  seq: room.seq,
                  type: 'Error',
                  payload: {
                    code: 'COMMAND_REJECTED',
                    message: 'Combat command could not be accepted.',
                    actionId: msg.actionId,
                  },
                }),
              );
          }
          if (msg.type === 'XCard') {
            const xCard = XCardSchema.safeParse(msg);
            if (!xCard.success) {
              send({
                seq: room.seq,
                type: 'Error',
                payload: {
                  code: 'INVALID_ACTION',
                  message: 'X-card request is invalid.',
                  actionId: msg.actionId,
                },
              });
              return;
            }
            return room.xCard(identity.accountId);
          }
          if (msg.type === 'RewindTurn') {
            const rewind = RewindTurnSchema.safeParse(msg);
            if (!rewind.success) {
              send({
                seq: room.seq,
                type: 'Error',
                payload: {
                  code: 'INVALID_ACTION',
                  message: 'Rewind request is invalid.',
                  actionId: msg.actionId,
                },
              });
              return;
            }
            return room
              .rewindLastTurn(identity.accountId)
              .catch((error: unknown) => {
                if (error instanceof NotTableHostError)
                  return send({
                    seq: room.seq,
                    type: 'Error',
                    payload: {
                      code: 'NOT_HOST',
                      message: 'Only the table host can rewind.',
                      actionId: msg.actionId,
                    },
                  });
                if (error instanceof RewindRefusedError)
                  return send({
                    seq: room.seq,
                    type: 'Error',
                    payload: {
                      code: 'REWIND_REFUSED',
                      message: error.message,
                      actionId: msg.actionId,
                    },
                  });
                app.log.error(
                  { err: error, sessionId: identity.sessionId },
                  'Rewind request failed',
                );
                send({
                  seq: room.seq,
                  type: 'Error',
                  payload: {
                    code: 'ACTION_REJECTED',
                    message: 'Rewind request could not be accepted.',
                    actionId: msg.actionId,
                  },
                });
              });
          }
          if (msg.type === 'PauseTable') {
            const pause = PauseTableSchema.safeParse(msg);
            if (!pause.success) {
              send({
                seq: room.seq,
                type: 'Error',
                payload: {
                  code: 'INVALID_ACTION',
                  message: 'Pause request is invalid.',
                  actionId: msg.actionId,
                },
              });
              return;
            }
            return db
              .query<{ host: boolean }>(
                'SELECT owner_account_id=$2 AS host FROM sessions WHERE id=$1',
                [identity.sessionId, identity.accountId],
              )
              .then((result) =>
                room.setPaused(
                  identity.accountId,
                  pause.data.payload.paused,
                  result.rows[0]?.host === true,
                ),
              )
              .catch((error: unknown) => {
                if (!(error instanceof NotTableHostError)) {
                  app.log.error(
                    { err: error, sessionId: identity.sessionId },
                    'Pause request failed',
                  );
                  send({
                    seq: room.seq,
                    type: 'Error',
                    payload: {
                      code: 'ACTION_REJECTED',
                      message: 'Pause request could not be accepted.',
                      actionId: msg.actionId,
                    },
                  });
                  return;
                }
                send({
                  seq: room.seq,
                  type: 'Error',
                  payload: {
                    code: 'NOT_HOST',
                    message: 'Only the table host can resume.',
                    actionId: msg.actionId,
                  },
                });
              });
          }
          if (msg.type === 'WithdrawAction') {
            const withdraw = WithdrawActionSchema.safeParse(msg);
            if (!withdraw.success) {
              send({
                seq: room.seq,
                type: 'Error',
                payload: {
                  code: 'INVALID_ACTION',
                  message: 'Withdraw request is invalid.',
                  actionId: msg.actionId,
                },
              });
              return;
            }
            return room
              .withdrawAction(
                identity.accountId,
                withdraw.data.payload.withdrawnActionId,
              )
              .then((withdrawn) => {
                if (!withdrawn)
                  send({
                    seq: room.seq,
                    type: 'Error',
                    payload: {
                      code: 'NOT_WITHDRAWABLE',
                      message: 'This action can no longer be withdrawn.',
                      actionId: withdraw.data.payload.withdrawnActionId,
                    },
                  });
              });
          }
          if (msg.type === 'ClarificationAnswer') {
            const answer = ClarificationAnswerSchema.safeParse(msg);
            if (!answer.success) {
              send({
                seq: room.seq,
                type: 'Error',
                payload: {
                  code: 'INVALID_ACTION',
                  message: 'Clarification reply is invalid.',
                  actionId: msg.actionId,
                },
              });
              return;
            }
            return app.inputGate
              .check({
                text: answer.data.payload.answer,
                surface: 'clarification',
                accountId: identity.accountId,
                sessionId: identity.sessionId,
              })
              .then((decision) => {
                if (decision === 'limited')
                  return send({
                    seq: room.seq,
                    type: 'Error',
                    payload: {
                      code: 'RATE_LIMITED',
                      message: 'Too many requests. Try again later.',
                      actionId: answer.data.payload.actionId,
                    },
                  });
                if (decision === 'block')
                  return send({
                    seq: room.seq,
                    type: 'Error',
                    payload: {
                      code: 'CONTENT_REJECTED',
                      message: 'That reply cannot be sent.',
                      actionId: answer.data.payload.actionId,
                    },
                  });
                return room
                  .answerClarification(
                    identity.accountId,
                    answer.data.payload.actionId,
                    answer.data.payload.answer,
                  )
                  .then((answered) => {
                    if (!answered)
                      send({
                        seq: room.seq,
                        type: 'Error',
                        payload: {
                          code: 'clarification-closed',
                          message: 'This question is no longer open.',
                          actionId: answer.data.payload.actionId,
                        },
                      });
                  });
              });
          }
          if (msg.type === 'PlayerAction') {
            const action = PlayerActionSchema.safeParse(msg);
            if (!action.success) {
              send({
                seq: room.seq,
                type: 'Error',
                payload: {
                  code: 'INVALID_ACTION',
                  message: 'Action is invalid.',
                  actionId: msg.actionId,
                },
              });
              return;
            }
            return Promise.all([
              app.inputGate.check({
                text: action.data.payload.text,
                surface: 'player-action',
                accountId: identity.accountId,
                sessionId: identity.sessionId,
              }),
              db.query<{ display_name: string }>(
                'SELECT display_name FROM accounts WHERE id=$1',
                [identity.accountId],
              ),
            ])
              .then(async ([allowed, name]) => {
                if (allowed === 'limited') return 'limited' as const;
                if (allowed === 'block') return 'rejected' as const;
                return room.submitAction(
                  identity.accountId,
                  action.data.actionId,
                  action.data.payload.text,
                  name.rows[0]?.display_name ?? identity.accountId,
                );
              })
              .then((accepted) => {
                if (accepted === 'limited')
                  return send({
                    seq: room.seq,
                    type: 'Error',
                    payload: {
                      code: 'RATE_LIMITED',
                      message: 'Too many requests. Try again later.',
                      actionId: msg.actionId,
                    },
                  });
                if (accepted === 'rejected')
                  return send({
                    seq: room.seq,
                    type: 'Error',
                    payload: {
                      code: 'CONTENT_REJECTED',
                      message: 'That action cannot be sent.',
                      actionId: msg.actionId,
                    },
                  });
                if (!accepted)
                  send({
                    seq: room.seq,
                    type: 'Error',
                    payload: {
                      code: 'DUPLICATE_ACTION',
                      message: 'This action was already received.',
                      actionId: msg.actionId,
                    },
                  });
              })
              .catch(() =>
                send({
                  seq: room.seq,
                  type: 'Error',
                  payload: {
                    code: 'ACTION_REJECTED',
                    message: 'Action could not be accepted.',
                    actionId: msg.actionId,
                  },
                }),
              );
            return;
          }
          send({
            seq: room.seq,
            type: 'Error',
            payload: {
              code: 'UNSUPPORTED_ACTION',
              message: 'Action not supported',
              actionId: msg.actionId,
            },
          });
        };
        const handleChat = async (
          action: ReturnType<typeof ChatSendSchema.parse>,
          receipt: import('../room/Room.js').ChatReceipt,
        ) => {
          const reject = async (
            reason: string,
            actionId: string,
            moderationLogId?: string,
          ) => {
            if (!receipt.decide(reason)) return;
            clearChatDeadline(receipt);
            send({
              seq: room.seq,
              type: 'Error',
              payload: {
                code: 'CHAT_REJECTED',
                message: CHAT_REJECTION,
                actionId: actionId as ActionId,
              },
            });
            try {
              await room.rejectChat(receipt, reason, moderationLogId);
            } catch {
              receipt.finish();
            }
          };
          if (receipt.decision !== undefined) return;
          if (!validOrigin(request.headers.origin, request.headers.host)) {
            await reject('authorization', action.actionId);
            return;
          }
          const [eligible, currentSeat] = await Promise.all([
            eligibleSession(db, identity.accountId, identity.sessionId).catch(
              () => undefined,
            ),
            currentSeatId(db, identity.accountId, identity.sessionId).catch(
              () => undefined,
            ),
          ]);
          const seat = room.state.seats.find(
            (candidate: { seatId: string }) => candidate.seatId === currentSeat,
          );
          if (eligible !== identity.sessionId || !currentSeat || !seat) {
            await reject('authorization', action.actionId);
            return;
          }
          let muted = false;
          try {
            const mute = await db.query<{ muted: boolean }>(
              `SELECT true AS muted FROM chat_mutes
                WHERE session_id=$1 AND seat_id=$2
                  AND (muted_until IS NULL OR muted_until>now()) LIMIT 1`,
              [identity.sessionId, seat.seatId],
            );
            muted = mute.rowCount === 1;
          } catch {
            await reject('unavailable', action.actionId);
            return;
          }
          if (muted || chatPolicy.isMuted(identity.sessionId, seat.seatId)) {
            const logId = await writeChatGateLog(
              identity.accountId,
              identity.sessionId,
            );
            await reject('muted', action.actionId, logId);
            return;
          }
          const admission = chatPolicy.reserve(
            identity.sessionId,
            seat.seatId,
            action.payload.text,
          );
          if (admission !== 'allow') {
            const logId = await writeChatGateLog(
              identity.accountId,
              identity.sessionId,
            );
            await reject(admission, action.actionId, logId);
            return;
          }
          if (!chatPolicy.reserveTableGate(identity.sessionId)) {
            const logId = await writeChatGateLog(
              identity.accountId,
              identity.sessionId,
            );
            await reject('busy', action.actionId, logId);
            return;
          }

          if (receipt.decision !== undefined) return;

          const failureLog = async () =>
            db
              .query<{ id: string }>(
                `INSERT INTO moderation_log(surface,account_id,session_id,category,source,fail_closed_row,expires_at)
                 VALUES('chat',$1,$2,'other','failclosed','tier',now() + interval '30 days') RETURNING id`,
                [identity.accountId, identity.sessionId],
              )
              .then((result) => result.rows[0]?.id)
              .catch(() => undefined);
          const check = app.inputGate.checkChat;
          if (!check) {
            await reject('judge_error', action.actionId, await failureLog());
            return;
          }
          const gateTimeoutMs = Math.min(
            5_000,
            Math.max(0, 10_000 - (performance.now() - receipt.receivedAt)),
          );
          if (gateTimeoutMs === 0) {
            await reject('deadline', action.actionId);
            return;
          }
          const gateAbort = new AbortController();
          chatAbortControllers.set(receipt, gateAbort);
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const gated = await Promise.race([
            check({
              text: action.payload.text,
              surface: 'chat',
              accountId: identity.accountId,
              sessionId: identity.sessionId,
              signal: gateAbort.signal,
            }).then(
              (result) => ({ result }),
              () => ({ failure: true as const }),
            ),
            new Promise<{ timeout: true }>((resolve) => {
              timeout = setTimeout(() => {
                gateAbort.abort();
                resolve({ timeout: true });
              }, gateTimeoutMs);
              timeout.unref?.();
            }),
          ]).finally(() => {
            clearTimeout(timeout);
            chatAbortControllers.delete(receipt);
          });
          if (receipt.decision !== undefined) return;
          if ('timeout' in gated || 'failure' in gated) {
            await reject('judge_error', action.actionId, await failureLog());
            return;
          }
          const decision = gated.result;
          if (decision.decision !== 'allow' || !decision.moderationLogId) {
            const attributable =
              decision.decision === 'block' && decision.attributable;
            if (
              attributable &&
              chatPolicy.recordNonAllow(
                identity.sessionId,
                seat.seatId,
                Date.now(),
                true,
              )
            )
              await db
                .query(
                  `INSERT INTO chat_mutes(session_id,seat_id,muted_until,source)
                   VALUES($1,$2,now() + interval '5 minutes','automatic')
                   ON CONFLICT(session_id,seat_id) DO UPDATE
                   SET muted_until=EXCLUDED.muted_until,source='automatic',updated_at=now(),updated_by=NULL`,
                  [identity.sessionId, seat.seatId],
                )
                .catch(() => {});
            const logId =
              decision.moderationLogId ??
              (await writeChatGateLog(identity.accountId, identity.sessionId));
            await reject(
              decision.decision === 'limited' ? 'busy' : 'moderation',
              action.actionId,
              logId,
            );
            return;
          }
          const stillSeated = await hasCurrentSeat(
            db,
            identity.accountId,
            identity.sessionId,
          ).catch(() => false);
          const currentSeatAfterGate = await currentSeatId(
            db,
            identity.accountId,
            identity.sessionId,
          ).catch(() => undefined);
          const muteAfterGate = await db
            .query(
              `SELECT 1 FROM chat_mutes WHERE session_id=$1 AND seat_id=$2
                AND (muted_until IS NULL OR muted_until>now()) LIMIT 1`,
              [identity.sessionId, seat.seatId],
            )
            .then((result) => result.rowCount === 1)
            .catch(() => true);
          if (
            !validOrigin(request.headers.origin, request.headers.host) ||
            !stillSeated ||
            currentSeatAfterGate !== seat.seatId ||
            muteAfterGate
          ) {
            await reject(
              'authorization',
              action.actionId,
              decision.moderationLogId,
            );
            return;
          }
          if (!receipt.decide('allow')) return;
          clearChatDeadline(receipt);
          const message = ChatMessageSchema.parse({
            messageId: randomUUID(),
            roomId: identity.sessionId,
            seatId: seat.seatId,
            receiptSeq: receipt.receiptSeq,
            receivedAt: receipt.receivedAt,
            text: action.payload.text,
            channel: 'ooc',
            gateDecision: {
              verdict: 'allow',
              moderationLogId: decision.moderationLogId,
            },
          });
          try {
            await room.commitChat(receipt, message, identity.accountId);
          } catch {
            send({
              seq: room.seq,
              type: 'Error',
              payload: {
                code: 'CHAT_REJECTED',
                message: CHAT_REJECTION,
                actionId: action.actionId,
              },
            });
          }
        };
        gate.dispatch = dispatch;
        for (const data of early.splice(0)) dispatch(data);
      })().catch(() => reject());
    });
  });
  const tick = setInterval(() => {
    void connections.sweep().catch(() => {});
  }, revalidateMs);
  tick.unref();
  const disconnectTasks = new Set<Promise<void>>();
  let closingGateway: Promise<void> | undefined;
  const closeSockets = () => {
    if (closingGateway) return closingGateway;
    shuttingDown = true;
    clearInterval(tick);
    closingGateway = (async () => {
      await Promise.all(
        [...wss.clients].map(
          (ws) =>
            new Promise<void>((resolve) => {
              if (ws.readyState === WebSocket.CLOSED) return resolve();
              ws.once('close', () => resolve());
              ws.close(1001, 'Server shutdown');
              const timeout = setTimeout(() => {
                ws.terminate();
                resolve();
              }, 500);
              timeout.unref();
            }),
        ),
      );
      await Promise.all([...disconnectTasks]);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    })();
    return closingGateway;
  };
  app.addHook('onClose', async () => {
    await closeSockets();
  });
  return closeSockets;
}
