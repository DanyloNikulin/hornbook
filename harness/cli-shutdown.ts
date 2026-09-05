import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FolderStore } from '../server/store.ts';
import { ProcessSupervisor } from '../scripts/lib/process-supervisor.ts';
import { Report, repoRoot, throwawayJournal } from './lib.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(signal: 'SIGINT' | 'SIGTERM', report: Report): Promise<void> {
  const journal = throwawayJournal(`cli-shutdown-${signal.toLowerCase()}`);
  const store = new FolderStore(journal);
  store.createSection({ target: 'es', learner: 'en' });
  store.updateSettings({ providers: { transcribe: { driver: 'skip', model: '-' }, extract: { driver: 'codex-cli', model: '-' } } });
  const heartbeat = join(journal, 'heartbeat');
  const leaf = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20);`;
  const fixture = join(journal, 'fixture-cli.cjs');
  writeFileSync(fixture, `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'inherit'});setInterval(()=>{},1000);`);
  const entry = join(journal, 'launcher-test.mjs');
  // Invoke the real launcher. IPC emits the Node signal event on Windows, where child.kill is a hard OS kill.
  writeFileSync(entry, `import {Server} from 'node:http';const listen=Server.prototype.listen;Server.prototype.listen=function(...args){this.once('listening',()=>process.send({port:this.address().port}));return listen.apply(this,args)};process.on('message',signal=>process.emit(signal));await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'bin', 'hornbook.mjs')).href)});`);
  const child = spawn(process.execPath, [entry, 'serve', '--journal', journal, '--port', '0'], {
    cwd: repoRoot, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, CODEX_BIN: fixture, HORNBOOK_TOOLS: join(journal, 'tools'), HORNBOOK_WORK: join(journal, 'work'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' },
  });
  let log = ''; child.stdout?.on('data', (data: Buffer) => { log += data.toString(); }); child.stderr?.on('data', (data: Buffer) => { log += data.toString(); });
  const supervised = new ProcessSupervisor(child, { ownsProcessGroup: process.platform !== 'win32', timeoutMs: 30_000 });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Launcher startup timed out: ' + log)), 15_000);
      child.once('message', (message: { port: number }) => { clearTimeout(timer); resolve(message.port); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(new Error('Launcher exited before startup: ' + log)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const submit = async () => {
      const response = await fetch(base + '/api/sections/es-en/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'process', filename: 'fixture.txt', base64: Buffer.from('Synthetic lesson fixture').toString('base64'), date: '2026-09-05' }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    };
    await submit(); await submit();
    for (let attempt = 0; attempt < 300 && !existsSync(heartbeat); attempt++) await pause(20);
    if (!report.rec(`${signal}: actual launcher starts the pipeline and fake CLI descendant`, existsSync(heartbeat), log.slice(-1000))) return;
    report.rec(`${signal}: both active and queued uploads are staged`, readdirSync(join(journal, '_uploads')).length === 2);
    child.send(signal);
    const exit = await supervised.completion;
    report.rec(`${signal}: launcher exits successfully after shutdown`, exit.code === 0, exit.error);
    report.rec(`${signal}: active and queued uploads are removed before launcher exit`, readdirSync(join(journal, '_uploads')).length === 0);
    const before = readFileSync(heartbeat, 'utf8'); await pause(100);
    let alive = true;
    try { process.kill(Number(before.split('.')[0]), 0); } catch { alive = false; }
    report.rec(`${signal}: descendant has exited and stopped writing`, !alive && readFileSync(heartbeat, 'utf8') === before);
  } finally { await supervised.stop('harness cleanup'); }
}

const report = new Report('cli-shutdown');
try { for (const signal of ['SIGINT', 'SIGTERM'] as const) await run(signal, report); }
catch (error) { report.rec('launcher shutdown harness', false, String(error)); }
report.finish();
