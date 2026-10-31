// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  NarrationText,
  renderInlineMarkdown,
  splitPrompt,
} from './narrationText.js';

// Generous for CI; the old backtracking regex took seconds at these sizes.
const BUDGET_MS = 200;

function timeMs(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

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

test('nested emphasis is shown wholly as literal text, not partly rendered', () => {
  const { container } = render(
    <NarrationText text="The rune says **bold *italic* text** plainly." />,
  );

  expect(container.querySelector('strong')).toBeNull();
  expect(container.querySelector('em')).toBeNull();
  expect(container.textContent).toBe(
    'The rune says **bold *italic* text** plainly.',
  );
});

test('unbalanced and mismatched markers render the whole paragraph as literal text', () => {
  for (const text of [
    'a **bold word',
    'a *b and **c**',
    'x *a *b* y',
    'p *a**b*',
  ]) {
    expect(renderInlineMarkdown(text)).toEqual([text]);
  }
});

test('adjacent runs of three or more asterisks are literal', () => {
  expect(renderInlineMarkdown('**a***b*')).toEqual(['**a***b*']);
  expect(renderInlineMarkdown('***a***')).toEqual(['***a***']);
});

test('empty emphasis and markers followed or preceded by spaces are literal', () => {
  for (const text of ['****', '**', '** **', '* *', 'a ** b']) {
    expect(renderInlineMarkdown(text)).toEqual([text]);
  }
});

test('a backslash-escaped asterisk is literal and never opens emphasis', () => {
  expect(renderInlineMarkdown('\\*not italic\\*')).toEqual([
    '\\*not italic\\*',
  ]);
});

test('a stray marker does not stop well-formed emphasis elsewhere in the paragraph', () => {
  const { container } = render(
    <NarrationText text="The scale reads 5 * 3 and the sign says **danger**." />,
  );

  expect(container.querySelector('strong')?.textContent).toBe('danger');
  expect(container.textContent).toContain('5 * 3');
});

test('a closing question whose markers straddle the split stays in the body', () => {
  expect(splitPrompt('*Hi.* **What?**')).toEqual({
    body: '*Hi.* **What?**',
    prompt: null,
  });
});

test('splitPrompt handles long whitespace runs in linear time', () => {
  const text = `word${' '.repeat(50_000)}x`;
  expect(timeMs(() => splitPrompt(text))).toBeLessThan(BUDGET_MS);
});

test('splitPrompt handles 50,000 repeated question fragments in linear time', () => {
  const text = '? '.repeat(50_000) + 'end';
  expect(timeMs(() => splitPrompt(text))).toBeLessThan(BUDGET_MS);
});

test('markdown rendering handles long runs of nested markers in linear time', () => {
  const nested = '*a '.repeat(20_000) + '?';
  expect(timeMs(() => renderInlineMarkdown(nested))).toBeLessThan(BUDGET_MS);
  expect(timeMs(() => splitPrompt('*'.repeat(50_000) + '?'))).toBeLessThan(
    BUDGET_MS,
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

test('a whitespace-only body renders no paragraph and no prompt', () => {
  const { container } = render(<NarrationText text={' \n\t \n  '} />);
  expect(container.querySelectorAll('p')).toHaveLength(0);
});

test('whitespace around the closing question does not leave an empty body paragraph', () => {
  const { container } = render(
    <NarrationText text={'  \n\n   \n\n**What do you do?**'} />,
  );
  const paragraphs = [...container.querySelectorAll('p')];
  expect(paragraphs).toHaveLength(1);
  expect(paragraphs[0]).toHaveClass('narration-log__prompt');
  expect(paragraphs[0]).toHaveTextContent('What do you do?');
});
