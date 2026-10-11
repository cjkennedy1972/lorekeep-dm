// Loader for docs/security/moderation-rubric.md: returns fenced section bodies keyed by info-string tag.
export const REQUIRED_TAGS = [
  'rubric:family',
  'rubric:standard',
  'rubric:mature',
  'clause:mature',
  'verdict-schema',
];

export const CATEGORIES = [
  'none',
  'violence',
  'language',
  'sexual',
  'minor_sexual',
  'hate',
  'self_harm',
  'lines_veils',
  'other',
];

export function parseRubric(markdown) {
  const sections = new Map();
  let tag = null;
  let body = [];
  for (const line of markdown.split('\n')) {
    if (tag === null) {
      const open = line.match(/^```([a-z:-]+)$/);
      if (open) {
        tag = open[1];
        body = [];
      }
    } else if (line === '```') {
      if (sections.has(tag)) throw new Error(`duplicate section: ${tag}`);
      sections.set(tag, body.join('\n'));
      tag = null;
    } else {
      body.push(line);
    }
  }
  if (tag !== null) throw new Error(`unclosed section: ${tag}`);
  return sections;
}
