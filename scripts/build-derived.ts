#!/usr/bin/env node
// Rebuild `_derived/` (meta, vocab, cards, search index) for every section of
// the journal, and validate each section's cheat sheet. The server does the
// same thing per section on every lesson save; this CLI exists for the
// prebuild hook, CI, and after hand-editing lesson files.
//
//   tsx scripts/build-derived.ts                # all sections
//   tsx scripts/build-derived.ts --section es-en

import { existsSync, readFileSync } from 'node:fs';
import { Cheatsheet } from '../src/lib/schema.ts';
import { cheatsheetPath, journalDir, listSections, writeDerived, configPath } from './lib/journal.ts';

if (!existsSync(configPath())) {
  console.log(`No journal at ${journalDir()} — nothing to derive. Run "npm run migrate" or create a section.`);
  process.exit(0);
}

const i = process.argv.indexOf('--section');
const only = i >= 0 ? process.argv[i + 1] : null;
const sections = listSections().filter((s) => !only || s.id === only);
if (only && sections.length === 0) {
  console.error(`✘ Unknown section "${only}".`);
  process.exit(1);
}

for (const section of sections) {
  const bundle = writeDerived(section.id);
  console.log(
    `✓ ${section.id}: ${bundle.metas.length} lesson(s), ${bundle.vocab.length} vocab, ${bundle.cards.length} cards, ${bundle.searchDocs.length} search docs`,
  );

  const csPath = cheatsheetPath(section.id);
  if (existsSync(csPath)) {
    const result = Cheatsheet.safeParse(JSON.parse(readFileSync(csPath, 'utf8')));
    if (result.success) {
      const total = result.data.categories.reduce((n, c) => n + c.sections.length, 0);
      console.log(`  cheat sheet ok (${total} sections)`);
    } else {
      console.warn(`  ⚠ ${section.id}/_cheatsheet.json failed validation:`);
      console.warn(JSON.stringify(result.error.format(), null, 2));
    }
  }
}
