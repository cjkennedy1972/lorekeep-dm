import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_PATH,
  RUBRIC_SOURCE,
  renderRubricModule,
} from '../../scripts/embed-moderation-rubric.mjs';

describe('embedded moderation rubric', () => {
  it('the committed generated module matches docs/security/moderation-rubric.md', () => {
    const expected = renderRubricModule(readFileSync(RUBRIC_SOURCE, 'utf8'));
    const committed = readFileSync(GENERATED_PATH, 'utf8');
    expect(
      committed,
      'run: pnpm --filter @game/server embed:moderation-rubric',
    ).toBe(expected);
  });

  it('the generated module is self-contained (no runtime file reads)', () => {
    const generated = readFileSync(GENERATED_PATH, 'utf8');
    expect(generated).not.toMatch(/node:fs|readFile|import\s/);
  });
});
