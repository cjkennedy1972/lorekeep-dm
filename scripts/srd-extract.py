#!/usr/bin/env python3
"""Extract a name+stat index from the official SRD 5.2.1 PDF (CC-BY-4.0) for catalog-reconcile.mjs.

Usage: python3 scripts/srd-extract.py <SRD_CC_v5.2.1.pdf> docs/plan/verification/srd-5.2.1-index.json
Needs PyMuPDF (pip install pymupdf). Source: https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf
"""
import hashlib, json, re, sys
import pymupdf

pdf_path, out_path = sys.argv[1], sys.argv[2]
doc = pymupdf.open(pdf_path)
pages = [p.get_text() for p in doc]
sha = hashlib.sha256(open(pdf_path, 'rb').read()).hexdigest()
# page index for citations: line -> page
lines, page_of = [], []
for i, t in enumerate(pages):
    for ln in t.split('\n'):
        lines.append(ln.rstrip())
        page_of.append(i + 1)

def find(s, page=1, after=0):
    for i in range(after, len(lines)):
        if lines[i] == s and page_of[i] >= page:
            return i
    raise SystemExit(f'not found: {s}')

def num(s):
    return int(s.replace('−', '-').replace('+', ''))

# ---------- spells ----------
# the real section heading is the last standalone 'Spell Descriptions' before 'Rules Glossary' body
sp_start = find('Spell Descriptions', 100)
sp_end = find('Rules Glossary', 150, sp_start)
SCHOOLS = 'Abjuration|Conjuration|Divination|Enchantment|Evocation|Illusion|Necromancy|Transmutation'
hdr1 = re.compile(rf'^(?:Level (\d) ({SCHOOLS})|({SCHOOLS}) Cantrip) \(([^)]*)\)?\s*$|^(?:Level (\d) ({SCHOOLS})|({SCHOOLS}) Cantrip) \((.*)$')
spells = {}
i = sp_start
while i < sp_end:
    cand = lines[i]
    nxt = lines[i + 1] if i + 1 < len(lines) else ''
    if cand and re.match(rf'^(Level \d ({SCHOOLS})|({SCHOOLS}) Cantrip) \(', nxt):
        h = nxt
        j = i + 2
        while ')' not in h:
            h += ' ' + lines[j].strip(); j += 1
        m = re.match(rf'^(?:Level (\d) ({SCHOOLS})|({SCHOOLS}) Cantrip) \(([^)]*)\)', h)
        if m and lines[j].startswith('Casting Time:'):
            level = int(m.group(1)) if m.group(1) else 0
            school = (m.group(2) or m.group(3)).lower()
            classes = sorted(c.strip().lower() for c in m.group(4).split(','))
            ct = lines[j][len('Casting Time:'):].strip()
            k = j + 1
            while not lines[k].startswith('Range:'):
                ct += ' ' + lines[k].strip(); k += 1
            rng = lines[k][len('Range:'):].strip(); k += 1
            comp = lines[k]
            while not lines[k + 1].startswith('Duration:'):
                k += 1; comp += ' ' + lines[k]
            comp = comp[len('Components:'):].strip(); k += 1
            dur = lines[k][len('Duration:'):].strip()
            k += 1
            while lines[k] and not re.match(r'^[A-Z\t ]', lines[k][:1] or 'x') and False:
                k += 1
            if level <= 3 and cand not in spells:
                spells[cand] = dict(level=level, school=school, classes=classes, castingTime=ct, range=rng,
                                    components=comp, duration=dur, page=page_of[i])
            i = k
            continue
    i += 1

# ---------- monsters ----------
mon_start = find('Monsters A–Z', 250)
mon_end = len(lines)
SIZES = 'Tiny|Small|Medium|Large|Huge|Gargantuan'
monsters = {}
i = mon_start
while i < mon_end - 3:
    if re.match(rf'^({SIZES})( or ({SIZES}))? [A-Za-z ,()]+, ', lines[i + 1]) and lines[i + 2].startswith('AC ') and lines[i] and len(lines[i]) < 40:
        name = lines[i]
        j = i + 1
        typeline = lines[j]
        blk = []
        k = i + 2
        while k < mon_end and not (re.match(rf'^({SIZES})( or ({SIZES}))? [A-Za-z ,()]+, ', lines[k + 1] if k + 1 < len(lines) else '') and lines[k + 2].startswith('AC ')) and not lines[k].startswith('CR ') :
            blk.append(lines[k]); k += 1
        if k < len(lines) and lines[k].startswith('CR '):
            blk.append(lines[k])
        text = '\n'.join(blk)
        m = re.match(rf'^({SIZES})(?: or [A-Za-z]+)? (.+), ([A-Za-z ]+)$', typeline)
        cr_m = re.match(r'CR ([\d/]+)', blk[-1]) if blk else None
        if cr_m:
            cr_s = cr_m.group(1)
            cr = eval(cr_s) if '/' in cr_s else int(cr_s)
            d = dict(page=page_of[i], size=m.group(1).lower() if m else None, type=(m.group(2).split(' (')[0].lower() if m else None),
                     cr=cr)
            for ln in blk:
                if ln.startswith('AC '):
                    d['ac'] = int(re.match(r'AC (\d+)', ln).group(1))
                mm = re.match(r'Initiative ([+−-]\d+)', ln)
                if mm: d['initiative'] = num(mm.group(1))
                mm = re.match(r'HP (\d+) \(([^)]*)\)', ln)
                if mm: d['hp'] = int(mm.group(1)); d['hpDice'] = mm.group(2).replace(' ', '')
                mm = re.match(r'Speed (\d+) ft\.', ln)
                if mm: d['speed'] = int(mm.group(1))
                mm = re.search(r'Passive Perception (\d+)', ln)
                if mm: d['passivePerception'] = int(mm.group(1))
            ab = {}
            for a in ('Str', 'Dex', 'Con', 'Int', 'Wis', 'Cha'):
                mm = re.search(rf'^{a}\t\s*(\d+)', text, re.M)
                if mm: ab[a.lower()] = int(mm.group(1))
            if len(ab) == 6: d['abilities'] = ab
            if name not in monsters: monsters[name] = d
        i = k
        continue
    i += 1
monsters_all = len(monsters)
monsters = {n: d for n, d in monsters.items() if d['cr'] <= 5}

# ---------- classes ----------
CLASSES = ['Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter', 'Monk', 'Paladin', 'Ranger', 'Rogue', 'Sorcerer', 'Warlock', 'Wizard']
classes = {}
for c in CLASSES:
    s = find(f'Core {c} Traits')
    block = '\n'.join(lines[s:s + 40])
    hd = re.search(r'Hit Point Die\nD(\d+)', block)
    t = find(f'{c} Features', 1, s)
    PB = {1: 2, 2: 2, 3: 2, 4: 2, 5: 3, 6: 3}
    def row_start(n, frm):
        for k in range(frm, frm + 400):
            if lines[k] == str(n) and lines[k + 1] == f'+{PB[n]}' and (re.search(r'[A-Za-z]{3}', lines[k + 2]) or lines[k + 2] == '\u2014') and not re.fullmatch(r'\d*d\d+.*', lines[k + 2]):
                return k
        raise SystemExit(f'{c}: no row for level {n}')
    starts, frm = {}, t
    for n in range(1, 7):
        starts[n] = row_start(n, frm); frm = starts[n] + 2
    feats = {}
    for n in range(1, 6):
        cells = [x for x in lines[starts[n] + 2:starts[n + 1]] if re.search(r'[A-Za-z]{3}', x) and not re.fullmatch(r'\d*d\d+.*', x) and not re.fullmatch(r'[+\d]+ ft\.', x)]
        feats[n] = [x.strip() for x in ' '.join(cells).split(',') if x.strip()]
    classes[c] = dict(hitDie=int(hd.group(1)) if hd else None, page=page_of[s], featuresByLevel=feats)

# ---------- subclasses (SRD includes one per class) ----------
subclasses = {}
toc_end = find('Playing the Game', 4)  # end of contents pages
for i in range(0, toc_end):
    m = re.match(r'^(Barbarian|Bard|Cleric|Druid|Fighter|Monk|Paladin|Ranger|Rogue|Sorcerer|Warlock|Wizard) Subclass:\s*(.*)$', lines[i])
    if m:
        n, j = m.group(2), i + 1
        while not re.search(r'\.+\s*\d+\s*$', n):
            n += ' ' + lines[j].strip(); j += 1
        pg = int(re.search(r'(\d+)\s*$', n).group(1))
        n = re.sub(r'\s+', ' ', re.split(r'\.+\s*\d+\s*$', n)[0]).strip()
        subclasses[n] = dict(classId=m.group(1).lower(), page=pg)

# ---------- species / backgrounds / conditions ----------
bg_start = find('Background Descriptions', 80)
backgrounds = {}
for i in range(bg_start, bg_start + 60):
    if lines[i + 1].startswith('Ability Scores:'):
        backgrounds[lines[i]] = dict(page=page_of[i])
sp_s = find('Character Species', 80)
species = {}
SPECIES = ['Dragonborn', 'Dwarf', 'Elf', 'Gnome', 'Goliath', 'Halfling', 'Human', 'Orc', 'Tiefling']
for n in SPECIES:
    for i in range(sp_s, sp_s + 600):
        if lines[i] == n and lines[i + 1] in ('', ) or (lines[i] == n and re.match(r'^(Creature Type|Size|Speed)', lines[i + 1] or '')):
            species[n] = dict(page=page_of[i]); break
cond_names = ['Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious']
ci = find('Condition', 170)
conditions = {}
# glossary list of defined conditions follows 'This glossary defines these conditions:'
gi = next(i for i in range(ci, ci + 40) if 'defines these conditions' in lines[i])
k = gi + 1
while lines[k] in cond_names or lines[k] == '':
    if lines[k]: conditions[lines[k]] = dict(page=page_of[k])
    k += 1

# ---------- equipment ----------
equipment = {}
w = find('Name', 90)-1 if False else find('Weapons', 90, find('Equipment', 85))
k = w
cat = None
while not lines[k].startswith('Armor') or lines[k] != 'Armor':
    if lines[k].endswith('Weapons') and lines[k] != 'Weapons' and lines[k] != 'Name':
        cat = lines[k]
    elif cat and re.match(r'^(\d+d\d+|\d+) [A-Z][a-z]+$', lines[k + 1] or '') and lines[k] and not re.match(r'^[\d/]', lines[k]):
        equipment[lines[k]] = dict(group='weapon', category=cat, damage=lines[k + 1], weight=lines[k + 4], cost=lines[k + 5], page=page_of[k])
    k += 1
    if k > w + 400: break
a = find('Armor', 90, w + 50)
k = a
while lines[k] != 'Cost': k += 1
k += 1
while k < a + 170:
    if re.search(r'\(.*\)$', lines[k]) and 'Armor' in lines[k - 0] and 'Don or Doff' in lines[k]: k += 1; continue
    if 'Don or Doff' in lines[k] or lines[k].endswith('Armor (1 Minute to Don or Doff)'): k += 1; continue
    if re.search(r'GP$', lines[k]) and k >= 3:
        pass
    if lines[k] in ('Shield',) or (lines[k + 1] and re.match(r'^(\d+|\d+ \+ Dex modifier( \(max 2\))?|\+2)', lines[k + 1] or '') and not re.match(r'^\d', lines[k])):
        equipment[lines[k]] = dict(group='armor', ac=lines[k + 1], weight=lines[k + 4], cost=lines[k + 5], page=page_of[k])
    k += 1
    if lines[k] == 'Tools' or (lines[k].startswith('Tools') and k > a + 10): break
t = find('Artisan’s Tools', 90)
for i in range(t, t + 600):
    m = re.match(r'^([A-Z][A-Za-z’\' ]+?) \((\d+ [GSC]P)\)$', lines[i])
    if m and (lines[i + 1].startswith('Ability:') or lines[i + 1].startswith('Weight') or lines[i + 1].startswith('Variants')):
        equipment[m.group(1)] = dict(group='tool', cost=m.group(2), page=page_of[i])
g = find('Adventuring Gear', 94, t)
k = g + 4
while lines[k] != 'Weight' or True:
    if k > g + 400 or lines[k].startswith('Mounts and Other Animals') or lines[k] == 'Equipment' and k > g + 10: break
    if re.match(r'^(—|[\d/ ]+ lb\.|Varies)$', lines[k + 1] or '') and re.match(r'^[A-Z]', lines[k]) and not re.match(r'^(—|[\d/ ]+ lb\.|Varies|\d)', lines[k]):
        equipment.setdefault(lines[k], dict(group='gear', weight=lines[k + 1], cost=lines[k + 2], page=page_of[k]))
    k += 1

equipment = {n: d for n, d in equipment.items() if n not in ('Disadvantage', '\u2014')}
out = dict(
    source=dict(name='System Reference Document 5.2.1', license='CC-BY-4.0', publisher='Wizards of the Coast LLC',
                url='https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf', sha256=sha, pages=len(pages),
                note='This work includes material from the System Reference Document 5.2.1 by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd, licensed under CC-BY-4.0.'),
    counts=dict(spellsL0to3=len(spells), monstersCR0to5=len(monsters), monstersAllCr=monsters_all, classes=len(classes), subclasses=len(subclasses),
                species=len(species), backgrounds=len(backgrounds), conditions=len(conditions), equipment=len(equipment)),
    spells=spells, monsters=monsters, classes=classes, subclasses=subclasses, species=species, backgrounds=backgrounds,
    conditions=conditions, equipment=equipment)
json.dump(out, open(out_path, 'w'), indent=1, ensure_ascii=False, sort_keys=True)
print(json.dumps(out['counts']))
