// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { NarrationText, splitPrompt } from './narrationText.js';

test('bold and italic markers render as strong and em, not as literal asterisks', () => {
  const { container } = render(
    <NarrationText text="You reach **Marrowfell Well** at *dusk*." />,
  );

  expect(container.querySelector('strong')?.textContent).toBe(
    'Marrowfell Well',
  );
  expect(container.querySelector('em')?.textContent).toBe('dusk');
  expect(container.textContent).not.toContain('*');
});

test('raw HTML, links, and images from the model stay inert text', () => {
  const { container } = render(
    <NarrationText
      text={
        '<img src=x onerror="alert(1)"> [open](https://example.test) <script>x</script>'
      }
    />,
  );

  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('a')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  expect(container.textContent).toContain('<img src=x');
  expect(container.textContent).toContain('[open](https://example.test)');
});

test('an unmatched marker is shown as typed', () => {
  render(<NarrationText text="The rune reads 2 ** 3 and a lone * mark." />);

  expect(
    screen.getByText('The rune reads 2 ** 3 and a lone * mark.'),
  ).toBeInTheDocument();
});

test('blank lines become separate paragraphs', () => {
  const { container } = render(
    <NarrationText text={'First paragraph.\n\nSecond paragraph.'} />,
  );

  const paragraphs = container.querySelectorAll('p');
  expect(paragraphs).toHaveLength(2);
  expect(paragraphs[1]?.textContent).toBe('Second paragraph.');
});

test('the closing question is split into its own prompt line without changing its text', () => {
  const { container } = render(
    <NarrationText
      text={
        'The well hums with cold light.\n\nThe stone is warm. **What do you do?**'
      }
    />,
  );

  const prompt = container.querySelector('.narration-log__prompt');
  expect(prompt?.textContent).toBe('What do you do?');
  expect(prompt?.querySelector('strong')?.textContent).toBe('What do you do?');
  expect(container.textContent).toContain(
    'The well hums with cold light.The stone is warm.',
  );
});

test('splitPrompt leaves text without a trailing question alone', () => {
  expect(splitPrompt('The door opens.')).toEqual({
    body: 'The door opens.',
    prompt: null,
  });
  expect(splitPrompt('Ready? Then act. What now?')).toEqual({
    body: 'Ready? Then act.',
    prompt: 'What now?',
  });
});
