// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { expect, test } from 'vitest';
import { loadCharacterCatalog } from '../src/features/character/catalog';
import { CharacterBuilder, validateCharacter } from '@game/rules-engine';
import { CreationWizard } from '../src/features/character/CreationWizard';
import { gameStore } from '../src/state/store';

const catalog = loadCharacterCatalog();
const step = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Continue' }));
};

test('completes and saves a Fighter build with keyboard controls only', async () => {
  gameStore.setCharacter(null);
  const user = userEvent.setup();
  render(<CreationWizard />);
  await user.click(screen.getByRole('radio', { name: /Fighter/ }));
  await step(user);
  await user.click(screen.getByRole('radio', { name: /Soldier/ }));
  await step(user);
  await user.click(screen.getByRole('radio', { name: /Human/ }));
  await step(user);
  await user.click(screen.getByRole('radio', { name: /Standard array/ }));
  await step(user);
  const choices = screen.getAllByRole('checkbox');
  await user.click(choices[0]!);
  await user.click(choices[1]!);
  await step(user);
  await user.click(
    within(
      screen.getByRole('group', { name: 'Choose starting equipment' }),
    ).getAllByRole('radio')[0]!,
  );
  await step(user);
  await user.type(screen.getByLabelText('Character name'), 'Talia');
  await user.click(screen.getByRole('button', { name: 'Save character' }));
  expect(gameStore.getState().character).not.toBeNull();
  expect(gameStore.getState().character?.name).toBe('Talia');
  expect(validateCharacter(gameStore.getState().character!, catalog)).toEqual(
    [],
  );
});

test('point-buy over cap disables save and shows a reason', async () => {
  const user = userEvent.setup();
  render(<CreationWizard />);
  await user.click(screen.getByRole('radio', { name: /Fighter/ }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('radio', { name: /Soldier/ }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('radio', { name: /Human/ }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('radio', { name: /Point buy/ }));
  for (const ability of ['Strength', 'Dexterity', 'Constitution']) {
    fireEvent.change(screen.getByLabelText(`${ability} score`), {
      target: { value: '15' },
    });
  }
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  const skills = screen.getAllByRole('checkbox');
  await user.click(skills[0]!);
  await user.click(skills[1]!);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getAllByRole('radio', { name: /Option/ })[0]!);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(screen.getByLabelText('Character name'), 'Too Many');
  expect(screen.getByText(/limit is 27/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save character' })).toBeDisabled();
});

test('every builder option explanation is rendered', async () => {
  const user = userEvent.setup();
  render(<CreationWizard />);
  const builder = new CharacterBuilder(catalog);
  const all = builder.classOptions();
  const descriptions = new Set(all.map((option) => option.explanation));
  const text = document.body.textContent ?? '';
  for (const description of descriptions) expect(text).toContain(description);
  // Step-wise skill/equipment choices are class/background dependent; check every currently exposed choice too.
  await user.click(screen.getByRole('radio', { name: /Fighter/ }));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('radio', { name: /Soldier/ }));
  const selected = new CharacterBuilder(catalog)
    .setClass('class:fighter')
    .setBackground('background:soldier');
  expect(document.body.textContent).toContain(
    selected.backgroundOptions().find((o) => o.id === 'background:soldier')!
      .explanation,
  );
});

test('axe reports no violations on each wizard step', async () => {
  const user = userEvent.setup();
  render(<CreationWizard />);
  for (let i = 0; i < 7; i++) {
    expect((await axe(document.body)).violations).toEqual([]);
    if (i < 6)
      await user.click(screen.getByRole('button', { name: 'Continue' }));
  }
});
