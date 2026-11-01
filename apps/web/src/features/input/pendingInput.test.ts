import { expect, test } from 'vitest';
import { pendingInputFor } from './pendingInput.js';

const submission = {
  roundId: 'r1',
  actionId: 'a1',
  text: 'I open the door.',
  queued: true,
  submittedAt: 250,
};

test('a reloaded seat resumes its wait timer from the server submission time', () => {
  const now = 1_000;
  const pending = pendingInputFor(null, submission, now);
  expect(pending).toEqual({
    id: 'a1',
    text: 'I open the door.',
    acknowledged: true,
    submittedAt: 250,
  });
  expect(Math.floor((now - pending!.submittedAt) / 1000)).toBe(0);
});

test('local pending state wins over the seeded submission', () => {
  const local = {
    id: 'a1',
    text: 'edited',
    acknowledged: true,
    submittedAt: 5,
  };
  expect(pendingInputFor(local, submission, 1_000)).toBe(local);
});

test('no submission and no local state means nothing is pending', () => {
  expect(pendingInputFor(null, undefined, 1_000)).toBeNull();
});
