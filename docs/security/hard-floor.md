# Hard floor: deterministic input rules (M3-06)

Code: `apps/server/src/safety/hardFloor.ts`, gate `hardFloorGate.ts`. Fixtures: `apps/server/test/fixtures/hard-floor-fixtures.ts` (shared; reuse for M3-27 and M3-31 proof).

Scope: sexual content involving minors, checked on user input only (LLM output is out of scope for this module; the output classifier covers it). No model call, no tier input: the verdict is a pure function of the text and is identical at every content tier (ADR-016).

## What counts as a minor reference

Explicit youth or age markers only: child, children, kid, minor, underage, teen/teenager, tween, preteen, toddler, infant, baby, schoolgirl/schoolboy, "young/little girl/boy", an age under 18 ("15yo", "15 y/o", "age 15", "fifteen year old", "under 18", and a bare age after a link word: "she is 15"), school-grade terms (grade 1 to 12, "9th grade", middle/high/elementary school, kindergarten), and the loli/shota/jailbait terms.

**Policy (ATLAS decision):** bare gendered or family nouns (girl, boy, daughter, son, woman, man, mother) are not minor indicators on their own. Tradeoff: ordinary adult RPG prose is allowed ("the boy king's brother had sex with the queen's maid"; "the girls were raped and the men were hanged" is dark adult content, left to tier policy and the judge), at the cost of missing sexual content about a minor described only with a bare noun ("the boy was raped"). The LLM judge (M3-07) is the second layer for those cases. The cost of treating "minor" as unconditional is also known: "The minor demon had sex with the succubus." is blocked.

## Matching

Evaluated across the whole message, not per sentence. A minor reference and a sexual term match when they are (a) in the same sentence within 8 tokens, (b) in sentences up to two apart within 4 tokens, or (c) up to two sentences apart within 30 tokens when the sexual sentence uses a pronoun ("She is a child. Describe her sexually."). Text is folded first: NFKD, combining marks and format characters removed, a broad confusables map (Cyrillic, Greek, Cherokee, small caps, dotless i, Latin look-alikes), leet digits (`1` tried as both `i` and `l`), stretched letters, and runs of short pieces joined back together (`c h i l d`, `s-e-x-ua-l`).

Linear time: one pass, each position joins at most 12 short pieces. Worst case measured at the cap: under 60 ms for 20,000 characters (the previous version took 4.8 s on a 100k-token sentence). `MAX_INPUT_CHARS` (20,000) is enforced in the module: longer input is blocked as `input.over-limit` without being scanned. Callers cap input much lower (ws text 4,000, names 80).

## Where it runs

ws `PlayerAction.text` and `ClarificationAnswer.answer`; `POST /api/tables` table name and character name; `POST /api/rooms` and `/api/sessions` room name; signup and `PATCH /api/me` display name. Operator endpoint labels are operator-only and not checked. Block log line: `event`, `surface`, `rule`, `version`, `accountId` (absent at signup), 30-day `expiresAt`; never the text.

## Known limits

See `HARD_FLOOR_KNOWN_MISSES`: bare-noun minors, euphemism beyond the vocabulary, other languages, references more than 30 tokens apart. Fixture precision and recall are in-sample: the rules were tuned against them.
