import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';
import { App } from './App';

const renderAt = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

test('landmarks and skip link are present', () => {
  renderAt();
  expect(screen.getByRole('banner')).toBeInTheDocument();
  expect(
    screen.getByRole('navigation', { name: 'Primary' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  expect(
    screen.getByRole('link', { name: 'Skip to main content' }),
  ).toHaveAttribute('href', '#main');
});

test('skip link is the first tab stop', async () => {
  renderAt();
  await userEvent.tab();
  expect(
    screen.getByRole('link', { name: 'Skip to main content' }),
  ).toHaveFocus();
});

test.each(['/', '/settings'])(
  'jest-axe: zero violations on %s',
  async (path) => {
    const { container } = renderAt(path);
    expect((await axe(container)).violations).toEqual([]);
  },
);

test('text size and dyslexia font persist in localStorage and apply to <html>', async () => {
  const { unmount } = renderAt('/settings');
  await userEvent.selectOptions(screen.getByLabelText('Text size'), 'large');
  await userEvent.click(
    screen.getByRole('switch', { name: 'Dyslexia-friendly font' }),
  );
  expect(document.documentElement.dataset.textSize).toBe('large');
  expect(document.documentElement.dataset.dyslexiaFont).toBe('on');
  unmount();
  renderAt('/settings'); // fresh mount reads from localStorage
  expect(screen.getByLabelText('Text size')).toHaveValue('large');
  expect(
    within(document.body).getByRole('switch', {
      name: 'Dyslexia-friendly font',
    }),
  ).toBeChecked();
});
