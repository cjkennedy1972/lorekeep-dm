const words = (text: string): string[] =>
  text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLocaleLowerCase('und')
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Detects a verbatim run of at least five words despite case or punctuation changes. */
export function containsForbiddenWordRun(
  text: string,
  forbiddenText: readonly string[],
  minimumWords = 5,
): boolean {
  const textWords = words(text);
  if (textWords.length < minimumWords) return false;
  const textRuns = new Set<string>();
  for (let start = 0; start <= textWords.length - minimumWords; start += 1)
    textRuns.add(textWords.slice(start, start + minimumWords).join('\u0000'));

  return forbiddenText.some((forbidden) => {
    const forbiddenWords = words(forbidden);
    for (
      let start = 0;
      start <= forbiddenWords.length - minimumWords;
      start += 1
    ) {
      if (
        textRuns.has(
          forbiddenWords.slice(start, start + minimumWords).join('\u0000'),
        )
      )
        return true;
    }
    return false;
  });
}
