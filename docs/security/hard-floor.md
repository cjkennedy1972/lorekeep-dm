# Hard floor: deterministic input rules (M3-06)

Code: `apps/server/src/safety/hardFloor.ts`, gate `hardFloorGate.ts`. Fixtures: `apps/server/test/fixtures/hard-floor-fixtures.ts` (shared; reuse for M3-27 and M3-31 proof).

Scope: sexual content involving minors, checked on user input only (LLM output is out of scope for this module; the output classifier covers it). No model call, no tier input: the verdict is a pure function of the text and is identical at every content tier (ADR-016).

## Rule: message-level taint

A message is blocked when it contains a minor reference and a sexual term anywhere in the message. There is no sentence window and no token distance. Distance is not a defence: "She is a child. The wind howled for hours... She is naked and sexual." blocks.

Two independent flags are computed over the whole normalized text:

- `minor`: a minor reference (below), not exempted by an adult marker.
- `sexual`: a sexual term, or an undress verb before an object pronoun.

An explicit term (CSAM vocabulary such as `csam`, `lolicon`, `shota`) blocks on its own.

## Minor references

- Core terms: child, children, kid, minor, underage, teen/teenager, tween, preteen, toddler, infant, baby, childlike, schoolgirl/schoolboy, jailbait, loli, shota, and similar.
- Youth words: youth, youngster, youngling, and the nouns they take with the prefixes young, little, tiny, small ("tiny girl", "little boy"). A youth word blocks unless an adult marker (adult, grown, grownup, grownups) is within one token. The allowance applies to youth words only. Core terms and stated ages are never exempted, so "adult child" and "child aged 18" still block.
- Ages under 18: digits in any Unicode decimal-digit script (Arabic-Indic, Devanagari, fullwidth folded to ASCII), in forms "15yo", "15 y/o", "12 y.o.", "age 15", "15-year-old", "under 18", "no older than 12", and words "fifteen year old" or "one-five year old".
- Bare numbers: a bare digit 1 to 17 counts only when it sits next to a person noun or a link word ("girl 15", "15 girl", "girl, 12,", "she is 15"). A bare number word counts only for 5 to 17, so "two boys" stays adult prose. A number followed by a quantity unit ("15 days", "15 gold") is not an age.
- Euphemisms: "barely legal", "school uniform", "young-looking", "little one", "under age".
- School terms: grade 1 to 12, "9th grade", middle/high/elementary school, kindergarten, pre-school.

**Policy (ATLAS decision):** bare gendered or family nouns (girl, boy, daughter, son, woman, man, mother, lad) are not minor indicators on their own. Ordinary adult RPG prose is allowed ("The boy king's brother had sex with the queen's maid."). The cost is a miss for a minor described only with a bare noun ("the boy was raped by the ogre"); the LLM judge (M3-07) is the second layer for those.

## Sexual terms

- Sexual vocabulary: sex, sexual, sexy, sexualized, rape, molest, fondle, naked, nude, lewd, erotic, porn, buttocks, crotch, groin, genitals, breasts, and similar.
- "sex" is sexual only next to a neighbour: after have/has/had/having/in, or before with/scene/act and similar. It is not sexual before appeal, education, drive, symbol, or change. "laid" counts only after got/get/gets/getting ("got laid"; "was laid" stays allowed).
- Undress verbs (undress, strip, unclothe) count only before an object pronoun or determiner (her, him, them, the, his, their). "The child undressed for bed" stays allowed.

## Text folding

Applied before matching: NFKD, combining marks and format characters removed, a confusables map (Cyrillic, Greek, Cherokee, small caps, dotless i, Latin look-alikes), every Unicode decimal digit folded to ASCII, leet digits (`1` tried as both `i` and `l`), stretched letters collapsed (`chiiild`, `sexxxual`), letters joined by a dot of up to three letters (`c.h.i.l.d`, `sex.ual`), spelled compounds ("one-five" = 15), and runs of short pieces joined back together (`c h i l d`, `s-e-x-ua-l`).

## Where it runs

ws `PlayerAction.text` and `ClarificationAnswer.answer`; `POST /api/tables` table name and character name; `POST /api/rooms` and `/api/sessions` room name; signup and `PATCH /api/me` display name. Operator endpoint labels are operator-only and not checked. Block log line: `event`, `surface`, `rule`, `version`, `accountId` (absent at signup), 30-day `expiresAt`; never the text.

## Performance

Linear time: one pass over tokens, each start position joins at most 12 short pieces. Measured at the cap (20,000 characters): 43 ms worst case for the cases tried (`a `, `ab `, `1 `, `s `, `x.`, `under `, `child sexual `). `MAX_INPUT_CHARS` (20,000) is enforced in the module: longer input is blocked as `input.over-limit` without being scanned. Callers cap input much lower (ws text 4,000, names 80).

## Tradeoffs

- Message-level taint blocks adult text that pairs a child reference with a sexual term anywhere in the message. Three such fixtures are recorded in `HARD_FLOOR_KNOWN_FALSE_POSITIVES`. Accepted: a false block is recoverable, a miss is not.
- Euphemisms ("barely legal", "school uniform") always block, including when an adult is meant.
- Youth words exempted by an adult marker only; "the youth is naked and sexual" blocks, and "the grown youth is sexual" does not.
- Bare numbers 5 to 17 next to a person noun block, so "rolled 15 girl" style prose can flip.
- Known false positives also include adult sentences using "baby", "teen", "kindergarten", or "minor" as a non-age word ("the minor demon", "her baby blue dress").

## Measured (in-sample, 2026-10-10 fixture set)

- Positives blocked: 120 / 120.
- Negatives blocked: 0 / 76 (includes the 12 adult RPG sentences in `b4-*`).
- Known false positives blocked as recorded: 9 / 9.
- Known misses still allowed: 10 / 10 (all in `HARD_FLOOR_KNOWN_MISSES`).
- `packages/evals/redteam/boundary-100.json` hardFloor rows: blocked by `hardFloorRedteam.test.ts`.

These are in-sample numbers. The rules were tuned against the fixtures and are not a held-out estimate.

## Known limits

See `HARD_FLOOR_KNOWN_MISSES`: bare-noun minors ("the boy was raped by the ogre", "the lad is naked and sexual"), euphemisms beyond the vocabulary, other languages (Spanish, Russian, Chinese numerals), and youth/freshman words used ambiguously. Non-English text is the M3-07 judge's job.
