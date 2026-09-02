#!/usr/bin/env node
// Re-run the AI pipeline against an existing R2 object — useful after tuning
// prompts in scripts/lib/prompt.ts and wanting to refresh old lessons without
// re-uploading the audio.
//
// Usage:
//   tsx scripts/regenerate.ts <r2-key>                  e.g. 2026-01-01-passato-prossimo.m4a
//   tsx scripts/regenerate.ts <r2-key> --date YYYY-MM-DD
//
// Requires `gh` CLI authenticated against this repo (gh auth status).
// Triggers the existing process-lesson.yml workflow via repository_dispatch.

import { spawnSync } from 'node:child_process';

// Same rules as the dispatcher worker + process-lesson.yml: block bytes that
// break shell quoting inside double quotes (" $ ` \\ CR LF NUL), allow
// Unicode letters / spaces / commas, require a known audio/video extension.
const SAFE_R2_KEY = /^[^"$`\\\r\n\x00]+\.(mp4|m4a|mp3|wav|opus|ogg|webm|mov)$/iu;

function usage(): never {
  console.error('Usage: tsx scripts/regenerate.ts <r2-key> [--date YYYY-MM-DD]');
  console.error('Example: tsx scripts/regenerate.ts 2026-01-01-passato-prossimo.m4a');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

const r2Key = args[0];
let date: string | null = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--date') {
    date = args[++i] ?? null;
  } else {
    console.error(`Unknown argument: ${args[i]}`);
    usage();
  }
}

if (!SAFE_R2_KEY.test(r2Key)) {
  console.error(`✘ R2 key failed allowlist: ${r2Key}`);
  console.error('  Must match: path-safe chars + extension (mp4/m4a/mp3/wav/opus/ogg/webm/mov)');
  process.exit(1);
}
if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`✘ date must be YYYY-MM-DD, got: ${date}`);
  process.exit(1);
}

// Make sure gh is available + authenticated. Fail early with a clearer message
// than gh's own complaint.
const ghCheck = spawnSync('gh', ['auth', 'status'], { stdio: 'pipe', encoding: 'utf8' });
if (ghCheck.status !== 0) {
  console.error('✘ gh CLI is not authenticated. Run: gh auth login');
  process.exit(1);
}

const ghArgs = [
  'workflow',
  'run',
  'process-lesson.yml',
  '--field',
  `r2_key=${r2Key}`,
];
if (date) ghArgs.push('--field', `date=${date}`);

console.log(`Triggering process-lesson workflow:`);
console.log(`  r2_key = ${r2Key}`);
if (date) console.log(`  date   = ${date}`);

const run = spawnSync('gh', ghArgs, { stdio: 'inherit' });
if (run.status !== 0) {
  console.error('✘ gh workflow run failed');
  process.exit(run.status ?? 1);
}

console.log('\n✓ Workflow dispatched.');
console.log('  Watch: gh run watch  (or:  gh run list --workflow=process-lesson.yml --limit 1)');
