// Restartable real-server fixture for the browser Adventure #1 lifecycle proof.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import { it } from 'vitest';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { createSession } from '../../src/accounts/sessions.js';
import { createApp } from '../../src/app.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import { installGateway } from '../../src/gateway/ws.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

type StateFile = { token: string; accountId: string };

function playerText(request: LlmRequest): string {
  return request.messages
    .map((message) => {
      const encoded = [
        ...message.content.matchAll(
          /<<<PLAYER_DATA encoding=base64>>>\s*([A-Za-z0-9+/=]+)\s*<<<END_PLAYER_DATA>>>/g,
        ),
      ].map((match) => Buffer.from(match[1]!, 'base64').toString('utf8'));
      return `${message.content}\n${encoded.join('\n')}`;
    })
    .join('\n');
}

function adventureDm(): LlmAdapter {
  let marker = 'unmarked';
  return {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      const content = playerText(request);
      const trigger = content.match(/ADVANCE-[A-Z0-9-]+/g)?.at(-1);
      if (trigger) marker = trigger;
      const hasTools = (request.tools?.length ?? 0) > 0;
      const sawTool = request.messages.some(
        (message) => message.role === 'tool',
      );
      const chunks: LlmChunk[] =
        hasTools && trigger && !sawTool
          ? [
              {
                type: 'tool-call',
                id: `close-${marker}`,
                name: 'close_scene',
                arguments: { summary: `Adventure checkpoint ${marker}` },
              },
            ]
          : [{ type: 'text', delta: `The story advances at ${marker}.` }];
      for (const chunk of chunks) yield chunk;
    },
  };
}

it('serves the restartable Adventure #1 scripted server', async () => {
  const url = process.env.DATABASE_URL;
  const stateFile = process.env.LIVE_STATE_FILE;
  const port = Number(process.env.LIVE_API_PORT ?? 8799);
  if (!url || !stateFile)
    throw new Error('DATABASE_URL and LIVE_STATE_FILE required');
  process.env.NODE_ENV = 'test';
  const db = new Pool({ connectionString: url });
  let seed: StateFile;
  if (existsSync(stateFile)) {
    seed = JSON.parse(readFileSync(stateFile, 'utf8')) as StateFile;
  } else {
    const accountId = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Adventure Proof','active',true,now(),'v1',now())`,
      [accountId, `${accountId}@example.test`],
    );
    seed = {
      accountId,
      token: await createSession(db, accountId, 'adventure-e2e'),
    };
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(seed));
  }
  const fixturePath = `${stateFile}.ndjson`;
  const runner = new ProductionSoloTurnRunner(
    db,
    undefined,
    'record',
    fixturePath,
    adventureDm(),
  );
  const rooms = new RoomRegistry(
    new Persistence(db),
    new SessionLease(db),
    'adventure-e2e',
    600_000,
    60_000,
    runner,
  );
  const connections = new ConnectionRegistry(db);
  const app = createApp(db, { rooms, connections });
  installGateway(app, db, rooms, connections, 300);
  await app.listen({ host: '127.0.0.1', port });
  const bootToken = process.env.LIVE_BOOT_TOKEN;
  if (!bootToken) throw new Error('LIVE_BOOT_TOKEN required');
  writeFileSync(`${stateFile}.boot`, bootToken);
  const stop = () => {
    void rooms
      .drain()
      .then(() => app.close())
      .then(() => db.end())
      .then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise<void>(() => {});
}, 0);
