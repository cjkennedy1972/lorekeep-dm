import { expect, test } from 'vitest';
import { pendingInputFor } from './pendingInput.js';

const submission = {
  roundId: 'r1',
  actionId: 'a1',
  text: 'I open the door.',
  queued: true,
};

test('a reloaded seat shows its private round submission as pending', () => {
  expect(pendingInputFor(null, submission, 1_000)).toEqual({
    id: 'a1',
    text: 'I open the door.',
    acknowledged: true,
    submittedAt: 1_000,
  });
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
