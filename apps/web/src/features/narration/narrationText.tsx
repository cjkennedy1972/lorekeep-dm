import { Fragment, type ReactNode } from 'react';

// Only **bold** and *italic* are rendered. Everything else (HTML, links, images, headings) is
// left as the literal characters the model wrote. React escapes every string child, so no
// markup from narration can reach the DOM.
const EMPHASIS = /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*|\*(?!\s)([^*\n]+?)(?<!\s)\*/g;

/** Renders the bold and italic subset of narration markdown as React nodes. */
export function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(EMPHASIS)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const [whole, bold, italic] = match;
    nodes.push(
      bold !== undefined ? (
        <strong key={start}>{bold}</strong>
      ) : (
        <em key={start}>{italic}</em>
      ),
    );
    last = start + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// A closing question on the last line of the DM's turn, optionally wrapped in bold markers.
const CLOSING_QUESTION = /\s*(\*{0,2}[^.!?\n]*\?\*{0,2})\s*$/;

/**
 * Splits a closing question such as "What do you do?" off the end of a paragraph so it can be
 * shown on its own line. Only display changes: the question keeps its characters.
 */
export function splitPrompt(paragraph: string): {
  body: string;
  prompt: string | null;
} {
  const match = CLOSING_QUESTION.exec(paragraph);
  if (!match || !match[1]?.replace(/\*/g, '').trim())
    return { body: paragraph, prompt: null };
  return {
    body: paragraph.slice(0, match.index).trimEnd(),
    prompt: match[1],
  };
}

/** Narration prose: blank lines start a new paragraph and the closing question stands alone. */
export function NarrationText({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
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
