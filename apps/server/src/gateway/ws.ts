import type { createApp } from '../app.js';
import type { Pool } from 'pg';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ClientEnvelopeSchema,
  PlayerActionSchema,
  type ServerMessage,
} from '@game/schema';
import { authenticateRequest } from '../middleware/auth.js';
import type { RoomRegistry } from '../room/registry.js';
import {
  consumeTicket,
  eligibleSession,
  issueTicket,
  validOrigin,
} from './tickets.js';
import { ConnectionRegistry } from './connections.js';

const MAX_BYTES = 64 * 1024;
export function installGateway(
  app: ReturnType<typeof createApp>,
  db: Pool,
  rooms: RoomRegistry,
  connections: ConnectionRegistry = new ConnectionRegistry(db),
  revalidateMs = 15_000,
): () => Promise<void> {
  app.post<{ Body?: { sessionId?: string } }>(
    '/api/ws-ticket',
    async (request, reply) => {
      if (!validOrigin(request.headers.origin, request.headers.host))
        return reply.code(403).send({ error: 'origin' });
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
        const connection = {
          send: (message: ServerMessage) => {
            if (ws.readyState === WebSocket.OPEN) {
              if (ws.bufferedAmount > MAX_BYTES * 4) {
                ws.close(1013, 'Slow consumer');
                return;
              }
              ws.send(JSON.stringify(message));
            }
          },
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
        try {
          const name = await db.query<{ display_name: string }>(
            'SELECT display_name FROM accounts WHERE id=$1',
            [identity.accountId],
          );
          await room.join(
            identity.accountId,
            connection,
            name.rows[0]?.display_name ?? identity.accountId,
          );
          if (!active) {
            await room.disconnect(identity.accountId);
            return;
          }
        } catch {
          clearInterval(heartbeat);
          ws.close(1011, 'Join failed');
          return;
        }
        ws.on('message', (data) => {
          void connections
            .sweepIfStale()
            .catch(() => {})
            .then(() => {
              if (ws.readyState === WebSocket.OPEN) handle(data);
            });
        });
        const handle = (data: import('ws').RawData) => {
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
          if (msg.type === 'Resync') {
            void room
              .subscribe(identity.accountId, connection, -1)
              .catch(() => ws.close(1011));
            return;
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
            void db
              .query<{ display_name: string }>(
                'SELECT display_name FROM accounts WHERE id=$1',
                [identity.accountId],
              )
              .then((name) =>
                room.submitAction(
                  identity.accountId,
                  action.data.actionId,
                  action.data.payload.text,
                  name.rows[0]?.display_name ?? identity.accountId,
                ),
              )
              .then((accepted) => {
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
