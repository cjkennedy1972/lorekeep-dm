#!/usr/bin/env python3
"""Extract SRD CC-BY-4.0 PDF text into stable page-cited search passages."""
import hashlib
import json
import re
import sys
import pymupdf

if len(sys.argv) != 3:
    raise SystemExit('Usage: python3 scripts/srd-text-chunks.py SRD_CC_v5.2.1.pdf packages/engine/srd-text/chunks.json')
pdf_path, output_path = sys.argv[1:]
doc = pymupdf.open(pdf_path)
headings = sorted((page - 1, level, title) for level, title, page in doc.get_toc() if page > 4)
chunks = []
for page_index in range(4, len(doc)):
    lines = doc[page_index].get_text().splitlines()
    lines = [line.strip() for line in lines if line.strip() and line.strip() not in {'System Reference Document 5.2.1', str(page_index + 1)}]
    body = ' '.join(lines)
    if not body:
        continue
    # Keep the full hierarchy (section path) from the PDF's actual table of contents.
    active = []
    for heading_page, level, title in headings:
        if heading_page > page_index:
            break
        active = active[:level - 1] + [title]
    section_path = ' › '.join(active) or 'Playing the Game'
    passage = ''
    for sentence in re.split(r'(?<=[.!?])\s+', body):
        if len(passage) + len(sentence) > 900 and passage:
            chunks.append({'id': f'srd-{page_index + 1}-{len(chunks)}', 'sectionPath': section_path, 'text': passage.strip(), 'srdPage': page_index + 1})
            passage = ''
        passage = (passage + ' ' + sentence).strip()
    if passage:
        chunks.append({'id': f'srd-{page_index + 1}-{len(chunks)}', 'sectionPath': section_path, 'text': passage.strip(), 'srdPage': page_index + 1})
with open(pdf_path, 'rb') as source:
    digest = hashlib.sha256(source.read()).hexdigest()
corpus = {'metadata': {
    'attribution': 'This work includes material from the System Reference Document 5.2.1 by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd, licensed under CC-BY-4.0.',
    'source': 'https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf',
    'sourceSha256': digest,
    'regeneratedBy': 'python3 scripts/srd-text-chunks.py SRD_CC_v5.2.1.pdf packages/engine/srd-text/chunks.json',
    'license': 'CC-BY-4.0'}, 'chunks': chunks}
with open(output_path, 'w') as output:
    json.dump(corpus, output, ensure_ascii=False, separators=(',', ':'))
    output.write('\n')
print(f'Wrote {len(chunks)} SRD-only passages')
