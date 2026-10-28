import { Fragment, type ReactNode } from 'react';

// Only **bold** and *italic* are rendered. Everything else (HTML, links, images, headings) is
// left as the literal characters the model wrote. React escapes every string child, so no
// markup from narration can reach the DOM.

type Piece = { kind: 'text' | 'strong' | 'em'; value: string };

const isBlank = (char: string | undefined) =>
  char === undefined || /\s/.test(char);

/**
 * Splits text into plain and emphasis pieces, or returns null when the markers are ambiguous.
 *
 * Rules, applied in one left-to-right pass:
 * - A run of one or two asterisks that is followed by a non-space can open a span; a run that
 *   cannot open or close is an ordinary character and stays literal.
 * - A span closes only on a run of the same length, preceded by a non-space, with no newline
 *   inside. Its content is therefore never empty and never contains another marker.
 * - A run of three or more asterisks, a mismatched closer, a nested marker, or an opener that
 *   never closes makes the whole text ambiguous (null). The caller then shows it literally.
 * - A backslash escapes the character after it, so `\*` never opens or closes a span.
 *
 * Runs in one pass over the text, so the cost is linear in its length.
 */
function parseEmphasis(text: string): Piece[] | null {
  const pieces: Piece[] = [];
  let plainFrom = 0;
  let open: { at: number; len: number } | null = null;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '\n' && open) return null;
    if (char !== '*') {
      i++;
      continue;
    }
    let end = i;
    while (text[end] === '*') end++;
    const len = end - i;
    if (len > 2) return null;
    if (open) {
      if (len !== open.len || isBlank(text[i - 1])) return null;
      pieces.push({ kind: 'text', value: text.slice(plainFrom, open.at) });
      pieces.push({
        kind: len === 2 ? 'strong' : 'em',
        value: text.slice(open.at + len, i),
      });
      plainFrom = end;
      open = null;
    } else if (!isBlank(text[end])) {
      open = { at: i, len };
    }
    i = end;
  }
  if (open) return null;
  pieces.push({ kind: 'text', value: text.slice(plainFrom) });
  return pieces;
}

/** Renders the bold and italic subset of narration markdown as React nodes. */
export function renderInlineMarkdown(text: string): ReactNode[] {
  const pieces = parseEmphasis(text) ?? [
    { kind: 'text' as const, value: text },
  ];
  return pieces
    .filter((piece) => piece.value)
    .map((piece, index) => {
      if (piece.kind === 'strong')
        return <strong key={index}>{piece.value}</strong>;
      if (piece.kind === 'em') return <em key={index}>{piece.value}</em>;
      return piece.value;
    });
}

/**
 * Splits a closing question such as "What do you do?" off the end of a paragraph so it can be
 * shown on its own line. Only display changes: the question keeps its characters. The split is
 * skipped when either side would render ambiguously, so emphasis is never cut in half.
 */
export function splitPrompt(paragraph: string): {
  body: string;
  prompt: string | null;
} {
  const none = { body: paragraph, prompt: null };
  const trimmed = paragraph.trimEnd();
  let end = trimmed.length;
  while (trimmed[end - 1] === '*') end--;
  if (trimmed[end - 1] !== '?') return none;

  // Walk back to the previous sentence boundary or line start.
  let start = end - 1;
  while (start > 0 && !'.!?\n'.includes(trimmed[start - 1] ?? '')) start--;

  const prompt = trimmed.slice(start).trimStart();
  const body = trimmed.slice(0, start).trimEnd();
  if (!prompt.split('*').join('').trim()) return none;
  if (parseEmphasis(body) === null || parseEmphasis(prompt) === null)
    return none;
  return { body, prompt };
}

/** Blank lines (empty or whitespace-only) start a new paragraph. */
function toParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    const paragraph = lines.join('\n').trim();
    if (paragraph) paragraphs.push(paragraph);
    lines = [];
  };
  for (const line of text.split('\n')) {
    if (line.trim()) lines.push(line);
    else flush();
  }
  flush();
  return paragraphs;
}

/** Narration prose: blank lines start a new paragraph and the closing question stands alone. */
export function NarrationText({ text }: { text: string }) {
  const paragraphs = toParagraphs(text);
  const last = paragraphs.length - 1;
  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const { body, prompt } =
          index === last
            ? splitPrompt(paragraph)
            : { body: paragraph, prompt: null };
        return (
          <Fragment key={index}>
            {body && <p>{renderInlineMarkdown(body)}</p>}
            {prompt && (
              <p className="narration-log__prompt">
                {renderInlineMarkdown(prompt)}
              </p>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
