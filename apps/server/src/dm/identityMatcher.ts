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
  const suffix =
    [...part].length === 1 ? '' : String.raw`(?:es['’]?|s['’]?|['’]s|['’])?`;
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}])${needle}${suffix}(?![\p{L}\p{N}])`,
    'giu',
  );
}

export function mentionsIdentityPart(text: string, part: string): boolean {
  return identityPartPattern(part).test(text);
}

/** Match a complete multiword identity; never treat an ordinary component as a name. */
export function identityPattern(identity: string): RegExp {
  const parts = identityParts(identity);
  if (!parts.length) return /$a/u;
  const words = parts.map(escapeRegExp).join(String.raw`[^\p{L}\p{N}]+`);
  const suffix =
    [...parts.at(-1)!].length === 1
      ? ''
      : String.raw`(?:es['’]?|s['’]?|['’]s|['’])?`;
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}])${words}${suffix}(?![\p{L}\p{N}])`,
    'giu',
  );
}

export function mentionsIdentity(text: string, identity: string): boolean {
  return identityPattern(identity).test(text);
}
