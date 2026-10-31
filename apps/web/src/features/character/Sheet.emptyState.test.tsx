// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Sheet } from './Sheet.js';

const buildLink = <a href="/rooms/r1">Build or choose a character</a>;
const deadEnd = /No character selected/;

describe('Sheet empty states', () => {
  test('a seated player with a bound character never sees the dead-end text while it loads', () => {
    render(
      <Sheet character={null} hasBoundCharacter emptyAction={buildLink} />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading your character',
    );
    expect(screen.queryByText(deadEnd)).toBeNull();
    expect(
      screen.queryByRole('link', { name: 'Build or choose a character' }),
    ).toBeNull();
  });

  test('a seated player without a character gets a next step with the build action', () => {
    render(<Sheet character={null} emptyAction={buildLink} />);

    expect(
      screen.getByText(/You don’t have a character at this table yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Build or choose a character' }),
    ).toHaveAttribute('href', '/rooms/r1');
    expect(screen.queryByText(deadEnd)).toBeNull();
  });

  test('a host without a character gets host copy and the build action', () => {
    render(<Sheet character={null} isHost emptyAction={buildLink} />);

    expect(
      screen.getByText(/You’re hosting without a character/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Build or choose a character' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(deadEnd)).toBeNull();
  });

  test('a spectator sees watching copy and no build action', () => {
    render(<Sheet character={null} seated={false} emptyAction={buildLink} />);

    expect(screen.getByText(/You’re watching this table/)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Build or choose a character' }),
    ).toBeNull();
    expect(screen.queryByText(deadEnd)).toBeNull();
  });

  test('the loading status still wins over the seat copy before room state arrives', () => {
    render(<Sheet character={null} loading seated={false} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading your character',
    );
    expect(screen.queryByText(/watching this table/)).toBeNull();
  });
});
