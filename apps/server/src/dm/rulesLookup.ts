import type { Pool } from 'pg';

export const MAX_RULES_LOOKUP_CHARS = 1_600; // approximately 400-token target, hard ceiling above ADR's 400-token target
export const MAX_RULES_LOOKUP_RESULTS = 3;

export type RulesPassage = {
  sectionPath: string;
  text: string;
  srdPage: number;
};

/** Retrieve ranked SRD passages. The source corpus is the CC-BY-4.0 SRD 5.2.1 text. */
export async function rulesLookup(
  pool: Pick<Pool, 'query'>,
  topic: string,
): Promise<RulesPassage[]> {
  const normalizedTopic = topic.trim();
  if (normalizedTopic.length < 3 || normalizedTopic.length > 80) {
    throw new RangeError('topic must contain 3 to 80 characters');
  }
  const { rows } = await pool.query<RulesPassage>(
    `SELECT section_path AS "sectionPath", text, srd_page AS "srdPage"
       FROM srd_text_chunks
      WHERE search_vector @@ websearch_to_tsquery('english', $1)
      ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', $1)) DESC, srd_page, id
      LIMIT $2`,
    [normalizedTopic, MAX_RULES_LOOKUP_RESULTS],
  );
  const bounded: RulesPassage[] = [];
  let chars = 0;
  for (const row of rows) {
    const allowance = MAX_RULES_LOOKUP_CHARS - chars;
    if (allowance <= 0) break;
    const text = row.text.slice(0, allowance);
    bounded.push({ ...row, text });
    chars += text.length;
  }
  return bounded;
}
