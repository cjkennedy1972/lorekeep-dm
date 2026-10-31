const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function identityParts(identity: string): string[] {
  return identity
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Matches a whole identity component, including ordinary plurals and possessives. */
export function identityPartPattern(
  part: string,
  caseSensitive = false,
): RegExp {
  const needle = escapeRegExp(part);
  const suffix =
    [...part].length === 1 ? '' : String.raw`(?:es['’]?|s['’]?|['’]s|['’])?`;
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}])${needle}${suffix}(?![\p{L}\p{N}])`,
    caseSensitive ? 'gu' : 'giu',
  );
}

export function mentionsIdentityPart(text: string, part: string): boolean {
  return identityPartPattern(part).test(text);
}

const COMMON_WORD_NAME_PARTS = new Set(['will', 'jones', 'ember']);

export const isCommonWordNamePart = (part: string): boolean =>
  COMMON_WORD_NAME_PARTS.has(part.toLocaleLowerCase('und'));

/** Match a full identity and its useful component variants without matching bare common words. */
export function identityPatterns(identity: string): RegExp[] {
  const parts = identityParts(identity);
  if (!parts.length) return [/$a/u];
  const words = parts.map(escapeRegExp).join(String.raw`[^\p{L}\p{N}]+`);
  const tail = parts.at(-1)!;
  const suffix =
    [...tail].length === 1 ? '' : String.raw`(?:es['’]?|s['’]?|['’]s|['’])?`;
  const patterns = [
    new RegExp(
      String.raw`(?<![\p{L}\p{N}])${words}${suffix}(?![\p{L}\p{N}])`,
      'giu',
    ),
  ];
  for (const part of parts) {
    if (COMMON_WORD_NAME_PARTS.has(part.toLocaleLowerCase('und'))) {
      const needle = escapeRegExp(part);
      const inflected = String.raw`(?:es['’]?|s['’]?|['’]s|['’])`;
      patterns.push(
        new RegExp(
          String.raw`(?<![\p{L}\p{N}])${needle}${inflected}(?![\p{L}\p{N}])`,
          'giu',
        ),
        new RegExp(
          String.raw`(?<![\p{L}\p{N}])${needle}(?![\p{L}\p{N}])`,
          'gu',
        ),
      );
    } else {
      patterns.push(identityPartPattern(part));
    }
  }
  return patterns;
}

/** Registry rewrites preserve unrelated prose: components match stored case only. */
export function identityRewritePatterns(identity: string): RegExp[] {
  const parts = identityParts(identity);
  if (!parts.length) return [/$a/u];
  return [
    identityPatterns(identity)[0]!,
    ...parts
      .filter(
        (part) =>
          !(
            COMMON_WORD_NAME_PARTS.has(part.toLocaleLowerCase('und')) &&
            part === part.toLocaleLowerCase('und')
          ),
      )
      .map((part) => identityPartPattern(part, true)),
  ];
}

export function mentionsIdentity(
  text: string,
  identity: string,
  foldedText = text,
): boolean {
  return identityPatterns(identity).some((pattern) => {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
    pattern.lastIndex = 0;
    return pattern.test(foldedText);
  });
}
