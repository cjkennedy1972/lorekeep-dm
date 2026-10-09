// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ActionInput,
  QUICK_ACTIONS,
} from '../src/features/input/ActionInput.js';

describe('ActionInput', () => {
  it('submits free-text and keyboard-reachable named quick actions', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ActionInput onSubmit={onSubmit} />);
    await user.type(
      screen.getByLabelText('Your action'),
      '  I open the door.  ',
    );
    await user.click(screen.getByRole('button', { name: 'Send action' }));
    expect(onSubmit).toHaveBeenLastCalledWith('I open the door.');
    for (const action of QUICK_ACTIONS) {
      const button = screen.getByRole('button', { name: action.label });
      button.focus();
      expect(button).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(onSubmit).toHaveBeenLastCalledWith(action.text);
    }
  });

  it('shows an immediate queued/thinking state and allows editing the pending action', async () => {
    const user = userEvent.setup();
    const onEditPending = vi.fn();
    render(
      <ActionInput
        onSubmit={vi.fn()}
        pending
        pendingText="I search the room."
        onEditPending={onEditPending}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Queued: I search the room.',
    );
    await user.click(
      screen.getByRole('button', { name: 'Edit before resolution' }),
    );
    expect(onEditPending).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Look' })).toBeDisabled();
  });

  it('binds a clarifying reply to its originating action', async () => {
    const user = userEvent.setup();
    const onReply = vi.fn();
    render(
      <ActionInput
        onSubmit={vi.fn()}
        clarification={{ actionId: 'action-original', question: 'Which door?' }}
        onReply={onReply}
      />,
    );
    await user.type(screen.getByLabelText('Your reply'), 'The eastern door');
    await user.click(
      screen.getByRole('button', { name: 'Reply to this action' }),
    );
    expect(onReply).toHaveBeenCalledWith('action-original', 'The eastern door');
  });
});
