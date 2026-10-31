const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function identityParts(identity: string): string[] {
  return identity
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Matches a whole identity component, including ordinary plurals and possessives. */
export function identityPartPattern(part: string): RegExp {
  const needle = escapeRegExp(part);
  const suffix = [...part].length === 1 ? '' : String.raw`(?:['’]s|['’]|s)?`;
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}])${needle}${suffix}(?![\p{L}\p{N}])`,
    'giu',
  );
}

export function mentionsIdentityPart(text: string, part: string): boolean {
  return identityPartPattern(part).test(text);
}
