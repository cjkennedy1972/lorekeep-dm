#!/usr/bin/env node
// Reconcile packages/engine/catalog against the SRD 5.2.1 index (docs/plan/verification/srd-5.2.1-index.json,
// produced from the official CC-BY PDF by scripts/srd-extract.py). Read-only: never edits catalog data.
//
//   node scripts/catalog-reconcile.mjs            print summary
//   node scripts/catalog-reconcile.mjs --report   also write docs/plan/verification/m2-03-catalog-diff.json
//   node scripts/catalog-reconcile.mjs --json     print the full diff as JSON
//
// Exit 1 while any SRD entry is missing from the catalog (expected until M2-04), 0 otherwise.
import console from 'node:console';
import process from 'node:process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? undefined : process.argv[i + 1];
};
const catalogDir = arg('--catalog') ?? join(root, 'packages/engine/catalog');
const indexPath =
  arg('--index') ?? join(root, 'docs/plan/verification/srd-5.2.1-index.json');
const outPath =
  arg('--out') ?? join(root, 'docs/plan/verification/m2-03-catalog-diff.json');

const idx = JSON.parse(readFileSync(indexPath, 'utf8'));
const entries = readdirSync(catalogDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .flatMap((f) => JSON.parse(readFileSync(join(catalogDir, f), 'utf8')));
const byKind = (k) => entries.filter((e) => e.kind === k);

const norm = (s) =>
  String(s)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
const dehyphen = (s) => String(s).replace(/([a-z])- ([a-z])/g, '$1$2');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Diff names. srd/cat: Map<name, any>. Returns lists plus matched pairs. */
function diffNames(srd, cat) {
  const sk = new Map([...srd.keys()].map((n) => [norm(n), n]));
  const ck = new Map([...cat.keys()].map((n) => [norm(n), n]));
  const missing = [];
  const extra = [];
  const nameMismatch = [];
  const pairs = [];
  for (const [k, n] of sk) {
    if (!ck.has(k)) missing.push(n);
    else {
      pairs.push([n, ck.get(k)]);
      if (ck.get(k) !== n) nameMismatch.push({ srd: n, catalog: ck.get(k) });
    }
  }
  for (const [k, n] of ck) if (!sk.has(k)) extra.push(n);
  return { missing: missing.sort(), extra: extra.sort(), nameMismatch, pairs };
}

const stat = []; // {kind, entry, field, srd, catalog, cite}
const add = (kind, entry, field, s, c, cite) => {
  if (!eq(s, c)) stat.push({ kind, entry, field, srd: s, catalog: c, cite });
};

const ABIL = {
  strength: 'str',
  dexterity: 'dex',
  constitution: 'con',
  intelligence: 'int',
  wisdom: 'wis',
  charisma: 'cha',
};
const abilList = (s) =>
  String(s)
    .split(/,| and | or /)
    .map((x) => ABIL[x.trim().toLowerCase()])
    .filter(Boolean)
    .sort();

const kinds = {};
const record = (name, d, extraInfo = {}) => {
  const rest = { ...d, pairs: undefined };
  kinds[name] = {
    srdCount: extraInfo.srdCount,
    catalogCount: extraInfo.catalogCount,
    ...rest,
    ...extraInfo.more,
  };
};
const mapOf = (arr, key = 'name') => new Map(arr.map((e) => [e[key], e]));
const mapObj = (o) => new Map(Object.entries(o));

// ---- monsters (all fields below compared for every SRD monster CR 0-5) ----
{
  const cat = mapOf(byKind('monster'));
  const d = diffNames(mapObj(idx.monsters), cat);
  const fields = [];
  for (const [sn, cn] of d.pairs) {
    const s = idx.monsters[sn];
    const c = cat.get(cn);
    const sec = `SRD 5.2.1 p.${s.page}, ${s.page >= 344 ? 'Animals' : 'Monsters A-Z'} > ${sn}`;
    const a = (f, sv, cv) => add('monster', cn, f, sv, cv, sec);
    a('cr', s.cr, c.cr);
    a('size', s.size, c.size);
    a('creatureType', s.type, c.creatureType);
    a('ac', s.ac, c.ac);
    a('initiative', s.initiative, c.initiative);
    a('hp', s.hp, c.hp);
    a('hpDice', s.hpDice, String(c.hpDice).replace(/\s/g, ''));
    a('speed', s.speed, c.speed);
    a('passivePerception', s.passivePerception, c.passivePerception);
    for (const ab of Object.keys(s.abilities ?? {}))
      a(`abilities.${ab}`, s.abilities[ab], c.abilities?.[ab]);
    for (const [an, sa] of Object.entries(s.attacks ?? {})) {
      const ca = (c.attacks ?? []).find((x) => norm(x.name) === norm(an));
      if (!ca) {
        a(`attack:${an}`, 'present', 'absent');
        continue;
      }
      a(`attack:${an}.toHit`, sa.toHit, ca.toHit);
      a(
        `attack:${an}.damage`,
        `${sa.dice} ${sa.type}`,
        `${String(ca.damage?.[0]?.dice).replace(/\s/g, '')} ${ca.damage?.[0]?.type}`,
      );
    }
    fields.push(sn);
  }
  record('monster', d, {
    srdCount: Object.keys(idx.monsters).length,
    catalogCount: cat.size,
  });
}

// ---- spells ----
const parseCast = (t) => {
  const ritual = /or Ritual/.test(t);
  let m;
  let c;
  if (/^Bonus Action/.test(t)) c = { unit: 'bonus-action' };
  else if (/^Reaction/.test(t)) c = { unit: 'reaction' };
  else if ((m = t.match(/^(\d+) (minute|hour)/)))
    c = { unit: m[2], amount: +m[1] };
  else if (/^Action/.test(t)) c = { unit: 'action' };
  else c = { unit: t };
  return { c, ritual };
};
const parseDur = (t) => {
  let m;
  if (/^Instantaneous/.test(t)) return { kind: 'instantaneous', conc: false };
  if (/^Until dispelled or triggered/.test(t))
    return { kind: 'until-dispelled-or-triggered', conc: false };
  if (/^Until dispelled/.test(t))
    return { kind: 'until-dispelled', conc: false };
  const conc = /^Concentration/.test(t);
  m = t.match(/(?:up to )?(\d+) (round|minute|hour|day)s?/i);
  if (m)
    return {
      kind: 'timed',
      amount: +m[1],
      unit: m[2].toLowerCase(),
      upTo: conc || /^Up to/.test(t),
      conc,
    };
  return { kind: t, conc };
};
const parseRange = (t) => {
  let m;
  if ((m = t.match(/^(\d+) feet/))) return { kind: 'feet', feet: +m[1] };
  if ((m = t.match(/^(\d+) mile/))) return { kind: 'feet', feet: +m[1] * 5280 };
  if (/^Self/.test(t)) return { kind: 'self' };
  if (/^Touch/.test(t)) return { kind: 'touch' };
  if (/^Unlimited/.test(t)) return { kind: 'unlimited' };
  return { kind: t };
};
{
  const cat = mapOf(byKind('spell'));
  const d = diffNames(mapObj(idx.spells), cat);
  for (const [sn, cn] of d.pairs) {
    const s = idx.spells[sn];
    const c = cat.get(cn);
    const sec = `SRD 5.2.1 p.${s.page}, Spells > Spell Descriptions > ${sn}`;
    const a = (f, sv, cv) => add('spell', cn, f, sv, cv, sec);
    a('level', s.level, c.level);
    a('school', s.school, c.school);
    a('classes', s.classes, [...c.classes].sort());
    const { c: sc, ritual } = parseCast(s.castingTime);
    a('castingTime', sc, {
      unit: c.castingTime.unit,
      ...(c.castingTime.amount ? { amount: c.castingTime.amount } : {}),
    });
    a('ritual', ritual, !!c.ritual);
    const sr = parseRange(s.range);
    a(
      'range',
      sr,
      c.range.kind === 'feet'
        ? { kind: 'feet', feet: c.range.feet }
        : { kind: c.range.kind },
    );
    const comp = s.components;
    a('components.verbal', /(^|, )V\b/.test(comp), !!c.components.verbal);
    a('components.somatic', /(^|, )S\b/.test(comp), !!c.components.somatic);
    a('components.material', /(^|, )M\b/.test(comp), !!c.components.material);
    const mat = comp.match(/M \((.*)\)\s*$/);
    if (mat && c.components.materials)
      a(
        'components.materials',
        norm(dehyphen(mat[1])),
        norm(c.components.materials),
      );
    const sd = parseDur(s.duration);
    const cd = c.duration;
    a('duration.kind', sd.kind, cd.kind);
    if (sd.kind === 'timed' && cd.kind === 'timed') {
      a('duration.amount', sd.amount, cd.amount);
      a('duration.unit', sd.unit, cd.unit);
      a('duration.upTo', sd.upTo, !!cd.upTo);
    }
    a('concentration', sd.conc, !!c.concentration);
    if (s.damage?.length) {
      const cdmg = c.damage ?? [];
      if (!cdmg.length) a('damage', s.damage[0], 'absent');
      else {
        a(
          'damage.dice',
          s.damage[0][0],
          String(cdmg[0].dice).replace(/\s/g, ''),
        );
        const types = new Set(cdmg.flatMap((x) => x.types ?? []));
        if (!types.has(s.damage[0][1]))
          a('damage.type', s.damage[0][1], [...types]);
      }
    }
  }
  record('spell', d, {
    srdCount: Object.keys(idx.spells).length,
    catalogCount: cat.size,
  });
}

// ---- classes (hit die, primary ability, saves, level 1-5 feature names) ----
{
  const cat = mapOf(byKind('class'));
  const d = diffNames(mapObj(idx.classes), cat);
  const featureGaps = [];
  for (const [sn, cn] of d.pairs) {
    const s = idx.classes[sn];
    const c = cat.get(cn);
    const sec = `SRD 5.2.1 p.${s.page}, Classes > ${sn}`;
    add('class', cn, 'hitDie', s.hitDie, c.hitDie, sec);
    add(
      'class',
      cn,
      'primaryAbility',
      abilList(s.primaryAbility),
      [...c.primaryAbility].sort(),
      sec,
    );
    add(
      'class',
      cn,
      'saveProficiencies',
      abilList(s.saves),
      [...c.saveProficiencies].sort(),
      sec,
    );
    for (let lv = 1; lv <= 5; lv++) {
      const sf = (s.featuresByLevel[lv] ?? [])
        .map((x) => x.replace(/\s*\(.*\)$/, ''))
        .filter((x) => !/ Subclass$/.test(x)); // subclass choice row, modelled by subclass entries
      const cf = (c.features ?? [])
        .filter((f) => f.level === lv && !/ Subclass$/.test(f.name))
        .map((f) => f.name);
      const cset = new Set(cf.map(norm));
      const sset = new Set(sf.map(norm));
      for (const n of sf)
        if (!cset.has(norm(n)))
          featureGaps.push({
            class: cn,
            level: lv,
            srd: n,
            catalog: null,
            cite: sec + ` > ${sn} Features table, level ${lv}`,
          });
      for (const n of cf)
        if (!sset.has(norm(n)))
          featureGaps.push({
            class: cn,
            level: lv,
            srd: null,
            catalog: n,
            cite: sec + ` > ${sn} Features table, level ${lv}`,
          });
    }
  }
  record('class', d, {
    srdCount: Object.keys(idx.classes).length,
    catalogCount: cat.size,
    more: { featureGapsLevel1to5: featureGaps },
  });
}

// ---- subclasses (names only) ----
{
  const cat = mapOf(byKind('subclass'));
  const d = diffNames(mapObj(idx.subclasses), cat);
  record('subclass', d, {
    srdCount: Object.keys(idx.subclasses).length,
    catalogCount: cat.size,
  });
}

// ---- species ----
{
  const cat = mapOf(byKind('species'));
  const d = diffNames(mapObj(idx.species), cat);
  for (const [sn, cn] of d.pairs) {
    const s = idx.species[sn];
    const c = cat.get(cn);
    const sec = `SRD 5.2.1 p.${s.page}, Character Origins > Character Species > ${sn}`;
    const sizes = [...s.size.matchAll(/(Tiny|Small|Medium|Large)/g)].map((m) =>
      m[1].toLowerCase(),
    );
    if (!sizes.includes(c.size)) add('species', cn, 'size', sizes, c.size, sec);
    add('species', cn, 'speed', +s.speed.match(/\d+/)[0], c.speed, sec);
  }
  record('species', d, {
    srdCount: Object.keys(idx.species).length,
    catalogCount: cat.size,
  });
}

// ---- backgrounds ----
{
  const cat = mapOf(byKind('background'));
  const d = diffNames(mapObj(idx.backgrounds), cat);
  for (const [sn, cn] of d.pairs) {
    const s = idx.backgrounds[sn];
    const c = cat.get(cn);
    const sec = `SRD 5.2.1 p.${s.page}, Character Origins > Backgrounds > ${sn}`;
    add(
      'background',
      cn,
      'abilityOptions',
      abilList(s.abilities),
      [...c.abilityOptions].sort(),
      sec,
    );
    add(
      'background',
      cn,
      'skillProficiencies',
      s.skills.split(/ and /).map(norm).sort(),
      [...c.skillProficiencies].map(norm).sort(),
      sec,
    );
  }
  record('background', d, {
    srdCount: Object.keys(idx.backgrounds).length,
    catalogCount: cat.size,
  });
}

// ---- conditions (names only) ----
{
  const cat = mapOf(byKind('condition'));
  const d = diffNames(mapObj(idx.conditions), cat);
  record('condition', d, {
    srdCount: Object.keys(idx.conditions).length,
    catalogCount: cat.size,
  });
}

// ---- equipment: weapons and armor, then gear/tools ----
const cp = (t) => {
  const m = String(t)
    .replace(/,/g, '')
    .match(/^(\d+) ([GSC]P)$/);
  return m ? +m[1] * { GP: 100, SP: 10, CP: 1 }[m[2]] : null;
};
const lb = (t) => {
  const m = String(t)
    .replace('½', '.5')
    .match(/^(?:(\d+)\/(\d+)|(\d*\.?\d+)) lb\./);
  return m ? (m[1] ? +m[1] / +m[2] : +m[3]) : null;
};
for (const [label, srdGroups, catCats] of [
  ['equipment:weapon', ['weapon'], ['weapon']],
  ['equipment:armor', ['armor'], ['armor']],
  ['equipment:gear-and-tools', ['gear', 'tool'], ['gear']],
]) {
  const srd = new Map(
    Object.entries(idx.equipment).filter(([, v]) =>
      srdGroups.includes(v.group),
    ),
  );
  const cat = new Map(
    byKind('equipment')
      .filter((e) => catCats.includes(e.category))
      .map((e) => [e.name, e]),
  );
  const d = diffNames(srd, cat);
  for (const [sn, cn] of d.pairs) {
    const s = srd.get(sn);
    const c = cat.get(cn);
    const sec = `SRD 5.2.1 p.${s.page}, Equipment > ${s.group === 'weapon' ? 'Weapons' : s.group === 'armor' ? 'Armor' : s.group === 'tool' ? 'Tools' : 'Adventuring Gear'} > ${sn}`;
    const scost = cp(s.cost);
    const sw = lb(s.weight ?? '');
    if (scost !== null) add(label, cn, 'costCp', scost, c.costCp, sec);
    if (sw !== null && c.weight !== undefined)
      add(label, cn, 'weight', sw, c.weight, sec);
  }
  record(label, d, { srdCount: srd.size, catalogCount: cat.size });
}

// ---- summary ----
const byKindStat = {};
for (const s of stat) byKindStat[s.kind] = (byKindStat[s.kind] ?? 0) + 1;
const summary = Object.fromEntries(
  Object.entries(kinds).map(([k, v]) => [
    k,
    {
      srd: v.srdCount,
      catalog: v.catalogCount,
      missing: v.missing.length,
      extra: v.extra.length,
      nameMismatch: v.nameMismatch.length,
      statMismatches: byKindStat[k] ?? 0,
      ...(v.featureGapsLevel1to5
        ? { featureGapsLevel1to5: v.featureGapsLevel1to5.length }
        : {}),
    },
  ]),
);
const diff = {
  generatedFrom: {
    srd: idx.source,
    catalogDir: 'packages/engine/catalog',
    catalogEntries: entries.length,
  },
  summary,
  kinds,
  statMismatches: stat,
};
const totalMissing = Object.values(summary).reduce((n, s) => n + s.missing, 0);
// Spellbook is intentionally retained: the Wizard's class starting-equipment text names it,
// although the SRD equipment index has no corresponding gear-table entry.
const reviewedExtras = { 'equipment:gear-and-tools': ['Spellbook'] };
const unexpectedExtras = Object.entries(kinds).flatMap(([kind, value]) =>
  value.extra
    .filter((name) => !(reviewedExtras[kind] ?? []).includes(name))
    .map((name) => ({ kind, name })),
);
diff.reviewedExceptions = { extras: reviewedExtras, deferredGear: [] };

if (process.argv.includes('--json')) console.log(JSON.stringify(diff, null, 2));
else {
  console.log(`SRD 5.2.1 reconciliation (${idx.source.sha256.slice(0, 12)}…)`);
  console.log(
    'kind'.padEnd(26) + 'srd  cat  missing extra nameMismatch statMismatch',
  );
  for (const [k, s] of Object.entries(summary))
    console.log(
      k.padEnd(26) +
        [
          s.srd,
          s.catalog,
          s.missing,
          s.extra,
          s.nameMismatch,
          s.statMismatches +
            (s.featureGapsLevel1to5
              ? `(+${s.featureGapsLevel1to5} feature gaps)`
              : ''),
        ]
          .map((x) => String(x).padEnd(6))
          .join(''),
    );
  console.log(`total missing: ${totalMissing}`);
}
if (process.argv.includes('--report')) {
  writeFileSync(outPath, JSON.stringify(diff, null, 2) + '\n');
  console.error(`wrote ${outPath}`);
}
if (
  totalMissing > 0 ||
  unexpectedExtras.length > 0 ||
  Object.values(summary).some((s) => s.nameMismatch > 0 || s.statMismatches > 0)
) {
  console.error(
    `catalog reconciliation failed: ${totalMissing} missing entries; ${unexpectedExtras.length} unreviewed extras; ${Object.values(summary).reduce((n, s) => n + s.nameMismatch + s.statMismatches, 0)} name/stat mismatches`,
  );
  process.exit(1);
}
