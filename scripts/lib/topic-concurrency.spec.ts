import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalRepository } from './journal.ts';
import { applyProposal, normalizeProposal } from './vocab-proposal.ts';

let root: string;
let first: JournalRepository;
let second: JournalRepository;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hornbook-topic-race-'));
  writeFileSync(join(root, 'journal.config.json'), JSON.stringify({ brand: { name: 'Synthetic', tagline: 'Test' }, providers: { transcribe: { driver: 'skip', model: '-' }, extract: { driver: 'ollama', model: 'test' } }, sections: [{ id: 'es-en', target: 'es', learner: 'en' }] }));
  first = new JournalRepository(root);
  second = new JournalRepository(root);
  first.writeTopicCatalog('es-en', { categories: [], topics: [{ id: 'existing', categories: [], patterns: ['original'] }] });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('topic review snapshot ownership', () => {
  it.each(['addition', 'edit', 'removal', 'duplicate'])('preserves a competing %s and reports a stale proposal as failed', (change) => {
    const snapshot = first.readTopicCatalog('es-en');
    const current = structuredClone(snapshot);
    if (change === 'edit') current.topics[0].patterns = ['edited'];
    else if (change === 'removal') current.topics = [];
    else current.topics.push({ id: change === 'duplicate' ? 'proposed' : 'concurrent', categories: [], patterns: ['new'] });
    second.writeTopicCatalog('es-en', current);
    const proposal = normalizeProposal({ additions: [{ id: 'proposed', categories: [], regex_patterns: ['proposal'], reasoning: 'Synthetic' }] });
    const stale = applyProposal(proposal, snapshot, (next) => first.writeTopicCatalog('es-en', next, snapshot));
    expect(stale.additions).toBe(0);
    expect(stale.outcomes[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('changed during review') });
    expect(first.readTopicCatalog('es-en')).toEqual(current);
    const retry = applyProposal(proposal, current, (next) => first.writeTopicCatalog('es-en', next, current));
    expect(retry.additions).toBe(change === 'duplicate' ? 0 : 1);
    expect(first.readTopicCatalog('es-en').topics.filter((topic) => topic.id === 'proposed')).toHaveLength(1);
  });
});
