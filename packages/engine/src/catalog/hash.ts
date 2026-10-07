import { createHash } from 'node:crypto';

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Stable sha256 over entries sorted by id with key-sorted JSON. */
export function catalogVersionOf(entries: readonly { id: string }[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return createHash('sha256').update(canonical(sorted)).digest('hex');
}
