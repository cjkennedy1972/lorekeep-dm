// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { ActionInput } from './ActionInput.js';

test('a failed action comes back into the action box so it can be resent', () => {
  const { rerender } = render(<ActionInput onSubmit={vi.fn()} />);
  expect(screen.getByLabelText('Your action')).toHaveValue('');

  rerender(<ActionInput onSubmit={vi.fn()} initialText="I open the door." />);

  expect(screen.getByLabelText('Your action')).toHaveValue('I open the door.');
});

test('a retryable failure is shown beside the action box and Retry fires once', () => {
  const onRetry = vi.fn();
  render(
    <ActionInput
      onSubmit={vi.fn()}
      failure={{
        message: 'The DM could not complete that round.',
        canRetry: true,
      }}
      onRetry={onRetry}
    />,
  );

  expect(screen.getByRole('alert')).toHaveTextContent(
    'The DM could not complete that round.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry this action' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('a restricted account failure is explained with no Retry button', () => {
  render(
    <ActionInput
      onSubmit={vi.fn()}
      failure={{
        message: 'Live DM is not enabled for this account.',
        canRetry: false,
      }}
      onRetry={vi.fn()}
    />,
  );

  expect(screen.getByRole('alert')).toHaveTextContent(
    'Live DM is not enabled for this account.',
  );
  expect(
    screen.queryByRole('button', { name: 'Retry this action' }),
  ).not.toBeInTheDocument();
});

test('Retry empties the box while the retry is pending and after narration completes', () => {
  function Harness() {
    const [draft, setDraft] = useState('');
    const [failure, setFailure] = useState<{
      message: string;
      canRetry: boolean;
    } | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    return (
      <>
        <ActionInput
          onSubmit={(text) => setPending(text)}
          pending={pending !== null}
          pendingText={pending ?? undefined}
          pendingSince={Date.now()}
          initialText={draft}
          onDraftChange={setDraft}
          failure={failure}
          onRetry={() => {
            const text = 'I open the door.';
            setFailure(null);
            setDraft('');
            setPending(text);
          }}
        />
        <button
          type="button"
          onClick={() => {
            setPending(null);
            setDraft('I open the door.');
            setFailure({
              message: 'The DM could not complete that round.',
              canRetry: true,
            });
          }}
        >
          Simulate failure
        </button>
        <button type="button" onClick={() => setPending(null)}>
          Simulate narration complete
        </button>
      </>
    );
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText('Your action'), {
    target: { value: 'I open the door.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send action' }));
  fireEvent.click(screen.getByRole('button', { name: 'Simulate failure' }));
  expect(screen.getByLabelText('Your action')).toHaveValue('I open the door.');

  fireEvent.click(screen.getByRole('button', { name: 'Retry this action' }));
  expect(screen.getByLabelText('Your action')).toHaveValue('');
  expect(screen.getByRole('status')).toHaveTextContent(
    'Queued: I open the door.',
  );

  fireEvent.click(
    screen.getByRole('button', { name: 'Simulate narration complete' }),
  );
  expect(screen.getByLabelText('Your action')).toHaveValue('');
});
