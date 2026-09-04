// API smoke: starts its own server on a throwaway copy of the demo journal
// and walks every endpoint the UI uses. No model is needed; jobs that would
// need one are pointed at a model that cannot exist, so the failure path is
// exercised without spending anything. Nothing here touches ./journal or
// ~/Hornbook.
//
//   npm run harness:api
//
// Optional: WHISPER_BIN + WHISPER_MODEL to probe a real whisper.cpp install;
// a reachable Ollama (OLLAMA_HOST) to check the model list. Both are skipped
// when absent.

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { JournalConfigT } from '../src/lib/journal-config.ts';
import type { ProbeResult } from '../src/lib/api-types.ts';
import {
  Report,
  b64,
  client,
  exists,
  jobSummary,
  obj,
  ollamaHostFromEnv,
  outDir,
  reachable,
  readJson,
  repoRoot,
  startServer,
  throwawayJournal,
  waitJob,
} from './lib.ts';

const PORT = Number(process.env['HORNBOOK_HARNESS_PORT'] ?? 8797);
const TEST = 'ja-en';

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

async function main(): Promise<void> {
  const r = new Report('api-smoke');

  const journal = throwawayJournal('api-smoke', { fromDemo: true });
  const configPath = join(journal, 'journal.config.json');
  const config = readJson<JournalConfigT>(configPath);
  config.providers = {
    transcribe: { driver: 'skip', model: '-' },
    extract: { driver: 'ollama', model: 'hornbook-harness-no-such-model' },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  // Downloads of the setup checks land in a throwaway tools folder, never in the real one.
  const tools = join(journal, 'tools');
  const server = await startServer({ journal, port: PORT, env: { HORNBOOK_TOOLS: tools } });
  const api = client(server.api);
  r.rec('throwaway server up', true, server.api);

  try {
    r.section('read');
    const mode = await api('GET', '/api/mode');
    r.rec('GET /api/mode is local and points at the throwaway journal', mode.status === 200 && obj(mode)['mode'] === 'local' && samePath(String(obj(mode)['journal']), journal), mode.text);

    const cfg = await api('GET', '/api/config');
    const sections = (obj(cfg)['sections'] as { id: string; flags?: { target?: string; learner?: string } }[]) ?? [];
    const ids = sections.map((s) => s.id);
    r.rec('GET /api/config lists the two demo pairs', cfg.status === 200 && ids.includes('es-en') && ids.includes('it-en'), ids.join(','));
    r.rec('sections carry flag strings', sections.every((s) => !!s.flags?.target && !!s.flags?.learner), JSON.stringify(sections[0]?.flags));

    const settings = await api('GET', '/api/settings');
    const conns = (obj(settings)['connections'] as Record<string, { set: boolean }>) ?? {};
    r.rec('GET /api/settings sees no cloud keys (harness blanks them)', settings.status === 200 && conns['OPENAI_API_KEY']?.set === false && conns['ANTHROPIC_API_KEY']?.set === false, JSON.stringify(obj(settings)['providers']));

    const lessons = await api('GET', '/api/sections/es-en/lessons');
    r.rec('GET es-en lessons', lessons.status === 200 && Array.isArray(lessons.json) && lessons.json.length >= 1, `n=${Array.isArray(lessons.json) ? lessons.json.length : '?'}`);
    const lesson = await api('GET', '/api/sections/es-en/lessons/greetings');
    r.rec('GET es-en/greetings', lesson.status === 200 && String(obj(lesson)['title']).includes('Saludos'), String(obj(lesson)['title']));
    for (const kind of ['vocab', 'cards', 'search-index', 'cheatsheet']) {
      const d = await api('GET', `/api/sections/es-en/${kind}`);
      r.rec(`GET es-en/${kind}`, d.status === 200 && d.json !== null, `type=${Array.isArray(d.json) ? 'array' : typeof d.json}`);
    }
    r.rec('GET unknown lesson → 404', (await api('GET', '/api/sections/es-en/lessons/no-such-lesson')).status === 404);
    r.rec('GET unknown section → 404', (await api('GET', '/api/sections/nope/lessons')).status === 404);

    r.section('progress');
    const progress = await api('GET', '/api/sections/es-en/progress');
    r.rec('GET es-en/progress has sm2', progress.status === 200 && typeof obj(progress)['sm2'] === 'object', progress.text.slice(0, 120));
    const put = await api('PUT', '/api/sections/es-en/progress', progress.json);
    const again = await api('GET', '/api/sections/es-en/progress');
    r.rec('PUT progress round-trips', put.status === 200 && again.text === progress.text, `put=${put.status}`);
    r.rec('it-en progress is separate', (await api('GET', '/api/sections/it-en/progress')).status === 200);

    r.section('probe');
    r.rec('probe with a bad body → 400', (await api('POST', '/api/settings/probe', { nope: true })).status === 400);
    const skip = (await api('POST', '/api/settings/probe', { job: 'transcribe', driver: 'skip', model: '-' })).json as ProbeResult;
    r.rec('probe transcribe/skip is ready', skip.ok === true, skip.detail);
    const openaiNoKey = (await api('POST', '/api/settings/probe', { job: 'transcribe', driver: 'openai', model: 'gpt-4o-transcribe' })).json as ProbeResult;
    r.rec('probe transcribe/openai without a key stops before the network', openaiNoKey.ok === false && /key/i.test(openaiNoKey.detail), openaiNoKey.detail);
    const anthropicNoKey = (await api('POST', '/api/settings/probe', { job: 'extract', driver: 'anthropic', model: 'claude-sonnet-4-6' })).json as ProbeResult;
    r.rec('probe extract/anthropic without a key stops before the network', anthropicNoKey.ok === false && /key/i.test(anthropicNoKey.detail), anthropicNoKey.detail);
    const whisperMissing = (await api('POST', '/api/settings/probe', {
      job: 'transcribe',
      driver: 'whisper-cli',
      model: join(repoRoot, 'definitely-missing.bin'),
      connections: { WHISPER_BIN: join(repoRoot, 'definitely-missing.exe') },
    })).json as ProbeResult;
    r.rec('probe whisper-cli with missing files says which one', whisperMissing.ok === false && /No binary at/.test(whisperMissing.detail), whisperMissing.detail);

    const whisperBin = process.env['WHISPER_BIN'];
    const whisperModel = process.env['WHISPER_MODEL'];
    if (exists(whisperBin) && exists(whisperModel)) {
      const w = (await api('POST', '/api/settings/probe', { job: 'transcribe', driver: 'whisper-cli', model: whisperModel, connections: { WHISPER_BIN: whisperBin } })).json as ProbeResult;
      r.rec('probe whisper-cli with the real files', w.ok === true, w.detail);
    } else {
      r.skip('probe whisper-cli with the real files', 'set WHISPER_BIN and WHISPER_MODEL');
    }

    const ollama = ollamaHostFromEnv();
    if (await reachable(`${ollama}/api/tags`)) {
      const list = (await api('POST', '/api/settings/probe', { job: 'extract', driver: 'ollama', model: '' })).json as ProbeResult;
      r.rec('probe ollama with no model lists pulled writers and asks for a pick', list.ok === false && list.pick === true && Array.isArray(list.models) && list.models.length > 0, `${list.detail} models=${(list.models ?? []).join(', ')}`);
      const missing = (await api('POST', '/api/settings/probe', { job: 'extract', driver: 'ollama', model: 'hornbook-harness-no-such-model' })).json as ProbeResult;
      r.rec('probe ollama with an unpulled model is a plain failure', missing.ok === false && !missing.pick && /not pulled/.test(missing.detail), missing.detail);
      const first = list.models?.[0];
      if (first) {
        const chosen = (await api('POST', '/api/settings/probe', { job: 'extract', driver: 'ollama', model: first })).json as ProbeResult;
        r.rec(`probe ollama with ${first} is ready and says whether it reads slides`, chosen.ok === true && /slides/.test(chosen.detail), chosen.detail);
      }
    } else {
      const down = (await api('POST', '/api/settings/probe', { job: 'extract', driver: 'ollama', model: '' })).json as ProbeResult;
      r.rec('probe ollama when unreachable is a plain failure', down.ok === false && !down.pick && /Cannot reach/.test(down.detail), down.detail);
      r.skip('probe ollama model list', `no Ollama at ${ollama}`);
    }

    r.section('sections');
    const created = await api('POST', '/api/sections', { target: 'ja', learner: 'en', title: 'Harness pair' });
    r.rec(`POST /api/sections ${TEST} → 201`, created.status === 201 && obj(created)['id'] === TEST, created.text.slice(0, 160));
    r.rec('POST duplicate section → 409', (await api('POST', '/api/sections', { target: 'ja', learner: 'en' })).status === 409);
    r.rec('POST target === learner → 400', (await api('POST', '/api/sections', { target: 'en', learner: 'en' })).status === 400);

    const sample = {
      id: '2026-09-03-harness-smoke',
      date: '2026-09-03',
      slug: 'harness-smoke',
      title: 'Harness smoke lesson',
      summary: 'A tiny lesson written by the API harness, not a real class.',
      article_md: '## Takeaway\n\nThis exists only to exercise save, derived data, and cleanup.\n',
      duration_min: 5,
      vocabulary: [{ target: 'こんにちは', learner: 'hello', level: 'A1', example_target: 'こんにちは、元気ですか。', example_learner: 'Hello, how are you?' }],
      grammar: [{ rule: 'こんにちは is a daytime greeting.', examples: ['こんにちは'] }],
      quotes: [],
      quiz: [{ type: 'mc', q: 'What does こんにちは mean?', options: ['goodbye', 'hello', 'please'], answer: 1 }],
      flashcards: [{ front: 'こんにちは', back: 'hello', type: 'word', tags: ['A1'] }],
      slides: [],
      related: [],
      topics: ['vocabulary'],
    };
    const saved = await api('POST', `/api/sections/${TEST}/lessons`, sample);
    r.rec(`POST ${TEST} lesson`, saved.status === 200 && obj(saved)['slug'] === 'harness-smoke', saved.text.slice(0, 160));
    const vocab = await api('GET', `/api/sections/${TEST}/vocab`);
    r.rec('derived vocab rebuilt on save', vocab.status === 200 && vocab.text.includes('こんにちは'));
    r.rec('invalid lesson → 400', (await api('POST', `/api/sections/${TEST}/lessons`, { title: 'no' })).status === 400);
    const patched = await api('PATCH', `/api/sections/${TEST}`, { title: 'Renamed harness pair', theme: { preset: 'ink' } });
    r.rec(`PATCH ${TEST} title + theme`, patched.status === 200 && obj(patched)['title'] === 'Renamed harness pair', patched.text.slice(0, 160));

    r.section('transfer');
    const exportedPair = await fetch(`${server.api}/api/sections/${TEST}/export?progress=1`);
    const pairBytes = Buffer.from(await exportedPair.arrayBuffer());
    r.rec('pair export is a ZIP download', exportedPair.status === 200 && pairBytes[0] === 0x50 && pairBytes[1] === 0x4b, `${pairBytes.length} bytes`);
    const importedJournal = throwawayJournal('api-smoke-import');
    const importedServer = await startServer({ journal: importedJournal, port: PORT + 1, env: { HORNBOOK_TOOLS: join(importedJournal, 'tools') } });
    try {
      const importedApi = client(importedServer.api);
      const importedPair = await importedApi('POST', '/api/sections/import', { base64: pairBytes.toString('base64') });
      const importedLesson = await importedApi('GET', `/api/sections/${TEST}/lessons/harness-smoke`);
      r.rec(
        'pair imports into a fresh journal with the same lesson',
        importedPair.status === 200 && importedLesson.status === 200 && isDeepStrictEqual(importedLesson.json, saved.json),
        importedPair.text.slice(0, 180),
      );
      const duplicate = await importedApi('POST', `/api/sections/${TEST}/lessons/import`, { lesson: importedLesson.json });
      const conflictCount = ((obj(duplicate)['details'] as { conflicts?: unknown[] } | undefined)?.conflicts ?? []).length;
      r.rec('importing the same lesson twice returns a conflict choice', duplicate.status === 409 && conflictCount === 1, duplicate.text.slice(0, 180));
      const files = await importedApi('GET', `/api/sections/${TEST}/files`);
      r.rec('derived data is rebuilt, not carried in the archive', files.status === 200 && !files.text.includes('hornbook-section'), files.text);
    } finally {
      importedServer.stop();
    }

    r.rec('DELETE section with lessons → 409', (await api('DELETE', `/api/sections/${TEST}`)).status === 409);
    r.rec(`DELETE ${TEST} lesson`, (await api('DELETE', `/api/sections/${TEST}/lessons/harness-smoke`)).status === 200);
    r.rec(`DELETE empty ${TEST}`, (await api('DELETE', `/api/sections/${TEST}`)).status === 200);
    r.rec(`${TEST} gone`, (await api('GET', `/api/sections/${TEST}/lessons`)).status === 404);
    const after = (obj(await api('GET', '/api/config'))['sections'] as { id: string }[]).map((s) => s.id);
    r.rec('demo pairs intact', after.includes('es-en') && after.includes('it-en') && !after.includes(TEST), after.join(','));

    r.section('jobs');
    r.rec('bad job body → 400', (await api('POST', '/api/sections/es-en/jobs', { kind: 'process' })).status === 400);
    r.rec('unknown job id → 404', (await api('GET', '/api/jobs/nope')).status === 404);

    const demo = readJson<Record<string, unknown>>(join(repoRoot, 'journal', 'es-en', '2026-01-01-greetings.json'));
    demo['slug'] = 'json-copy';
    demo['id'] = '2026-09-03-json-copy';
    demo['title'] = 'JSON copy smoke';
    const copyPath = join(outDir, 'api-smoke-copy.json');
    writeFileSync(copyPath, JSON.stringify(demo));
    const jsonJob = await api('POST', '/api/sections/es-en/jobs', { kind: 'process', filename: 'copy.json', base64: b64(copyPath), date: '2026-09-03', from: 'json' });
    const jsonDone = await waitJob(api, String(obj(jsonJob)['id']), 60_000);
    r.rec('process JSON job needs no model and lands as a lesson', jsonDone?.status === 'done' && jsonDone.result?.slug === 'json-copy', jobSummary(jsonDone));
    r.rec('the copied lesson is served', (await api('GET', '/api/sections/es-en/lessons/json-copy')).status === 200);
    r.rec('the copied lesson can be deleted', (await api('DELETE', '/api/sections/es-en/lessons/json-copy')).status === 200);

    const cheat = await api('POST', '/api/sections/es-en/jobs', { kind: 'cheatsheet' });
    const cheatDone = await waitJob(api, String(obj(cheat)['id']), 120_000);
    r.rec('cheatsheet job on an impossible model fails with an error, not a hang', cheatDone?.status === 'failed' && !!cheatDone.error, jobSummary(cheatDone));
    // One demo lesson is below the review's minimum, so it stops before any
    // model call; a journal with more lessons would fail on the model instead.
    const review = await api('POST', '/api/sections/es-en/jobs', { kind: 'review-topics' });
    const reviewDone = await waitJob(api, String(obj(review)['id']), 120_000);
    const reviewClean = reviewDone?.status === 'failed' ? !!reviewDone.error : reviewDone?.status === 'done' && /too few/i.test(reviewDone.log);
    r.rec('review-topics job ends cleanly (too few lessons, or a clean error)', reviewClean, jobSummary(reviewDone));
    const listed = await api('GET', '/api/sections/es-en/jobs');
    r.rec('GET section jobs lists the three', listed.status === 200 && Array.isArray(listed.json) && listed.json.length === 3, `n=${Array.isArray(listed.json) ? listed.json.length : '?'}`);
    r.rec('server still answers after failed jobs', (await api('GET', '/api/mode')).status === 200);

    r.section('setup');
    const setup = await api('GET', '/api/setup');
    const rows = (obj(setup)['tools'] as { id: string; installed: boolean; source: string }[]) ?? [];
    r.rec('GET /api/setup lists the five tools', setup.status === 200 && rows.map((t) => t.id).join(',') === 'ffmpeg,whisper,whisper-model,ollama,ollama-model', rows.map((t) => `${t.id}:${t.installed ? t.source : 'missing'}`).join(' '));
    const rec = obj(setup)['recommend'] as { ollamaModel?: unknown } | undefined;
    r.rec('setup view names the tools folder and a recommendation', samePath(String(obj(setup)['toolsDir']), tools) && typeof rec?.ollamaModel === 'string', `${String(obj(setup)['toolsDir'])} → ${String(rec?.ollamaModel)}`);
    const ffm = rows.find((t) => t.id === 'ffmpeg');
    if (ffm?.installed) r.rec('an installed tool is detected, not fetched', ffm.source === 'system' || ffm.source === 'managed', `ffmpeg ${ffm.source}`);
    else r.skip('an installed tool is detected, not fetched', 'ffmpeg is not installed on this machine');
    r.rec('bad setup request → 400', (await api('POST', '/api/setup/jobs', { tool: 'nope' })).status === 400);
    if (await reachable('https://api.github.com/', 4000)) {
      const plan = await api('POST', '/api/setup/plan', { tool: 'whisper', variant: 'cpu' });
      const p = obj(plan);
      r.rec('a download plan names source, size and checksum before anything is fetched', plan.status === 200 && typeof p['sha256'] === 'string' && Number(p['sizeBytes']) > 0, `${String(p['fileName'])} ${String(p['sizeBytes'])} sha256 ${String(p['sha256']).slice(0, 12)}…`);
      const bad = await api('POST', '/api/setup/jobs', { tool: 'whisper', variant: 'cpu', sha256: '0'.repeat(64) });
      const badDone = await waitJob(api, String(obj(bad)['id']), 180_000);
      r.rec('a download with a wrong checksum fails cleanly and installs nothing', badDone?.status === 'failed' && /checksum mismatch/i.test(badDone.error ?? badDone.log) && !existsSync(join(tools, 'whisper')), jobSummary(badDone));
    } else {
      r.skip('download plan and wrong-checksum download', 'github.com not reachable');
    }
  } catch (err) {
    r.rec('harness runner', false, String(err));
  } finally {
    server.stop();
  }
  r.finish({ journal, serverLog: server.log().slice(-2000) });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
