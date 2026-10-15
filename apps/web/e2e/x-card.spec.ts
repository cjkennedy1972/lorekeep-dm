import { expect, test } from '@playwright/test';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

test('X-card signal is received and the player can pause the table', async ({
  page,
}) => {
  const email = `xcard${stamp()}@example.com`;
  const signup = await page.request.post('http://localhost:8787/api/signup', {
    data: {
      email,
      password: 'correct-horse-battery',
      displayName: 'X-card Player',
      birthdate: '1990-01-01',
    },
  });
  expect(signup.ok()).toBeTruthy();
  const created = await (
    await page.request.post('http://localhost:8787/api/rooms', {
      data: { name: 'Safety flow' },
    })
  ).json();

  let seq = 1;
  let paused = false;
  await page.routeWebSocket('**/ws?*', (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw)) as {
        type: string;
        payload: { paused?: boolean };
      };
      if (command.type === 'XCard') {
        socket.send(
          JSON.stringify({
            seq: ++seq,
            type: 'SafetyFlag',
            payload: { kind: 'x-card' },
          }),
        );
      } else if (command.type === 'PauseTable') {
        paused = command.payload.paused ?? false;
        socket.send(
          JSON.stringify({
            seq: ++seq,
            type: 'StateSync',
            payload: {
              state: {
                sessionId: '00000000-0000-4000-8000-0000000000c1',
                phase: 'lobby',
                seats: [],
                paused,
              },
            },
          }),
        );
      }
    });
    socket.send(
      JSON.stringify({
        seq,
        type: 'StateSync',
        payload: {
          state: {
            sessionId: '00000000-0000-4000-8000-0000000000c1',
            phase: 'lobby',
            seats: [],
            paused,
          },
        },
      }),
    );
  });

  await page.goto(`/rooms/${created.room.id}/game`);
  await expect(page.getByRole('heading', { name: 'Game' })).toBeVisible();
  await expect(page.getByText('Connected')).toBeVisible();

  await page.getByRole('button', { name: 'X-card: steer away' }).click();
  await expect(
    page.getByRole('status').filter({
      hasText: 'X-card received. The scene is steering away.',
    }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Pause table' }).click();
  await expect(
    page.getByRole('status').filter({
      hasText: 'Table paused. No new narration will start.',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Resume table' }),
  ).toBeVisible();
});
