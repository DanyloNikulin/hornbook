// Verify real release archives, and package a dirty synthetic checkout using the shipping rules.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { listPackage } from '@electron/asar';
import { repoRoot, outDir } from './lib.ts';

const require = createRequire(import.meta.url);
const config = require(join(repoRoot, 'electron-builder.config.cjs'));
const metadata = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const sentinel = 'HORNB0OK_PRIVATE_FIXTURE_9f81a5cc';
mkdirSync(outDir, { recursive: true });
const root = mkdtempSync(join(outDir, 'distribution-'));
const app = join(root, 'app');
const put = (path: string, text: string) => {
  const target = join(app, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
};
put('package.json', JSON.stringify({ ...metadata, dependencies: {}, devDependencies: {}, scripts: {}, main: 'dist/node/electron/main.js' }));
put('dist/node/electron/main.js', 'console.log("Synthetic distribution fixture");');
put('dist/hornbook/browser/index.html', '<h1>Synthetic distribution fixture</h1>');
for (const path of ['journal/secrets.json', 'journal/es-en/_progress.json', 'journal/es-en/2099-01-01-private.json', 'journal/_uploads/private.txt', 'journal/_transaction/before-0', 'journal/es-en/_progress.corrupt-private.json', '.env']) put(path, sentinel);
const configPath = join(root, 'builder.json');
writeFileSync(configPath, JSON.stringify({ ...config, directories: { app, output: join(root, 'desktop') }, win: { target: [{ target: 'dir', arch: ['x64'] }], signAndEditExecutable: false }, publish: null }));
execFileSync(process.execPath, [join(repoRoot, 'node_modules/electron-builder/cli.js'), '--dir', '--win', '--x64', '--config', configPath, '--publish', 'never'], { cwd: repoRoot, stdio: 'pipe', timeout: 180_000, windowsHide: true });
const archives = [join(root, 'desktop/win-unpacked/resources/app.asar'), ...process.argv.slice(2).map((path) => resolve(path))];
const results = archives.map((path) => {
  const files = listPackage(path, { isPack: false });
  const privateFiles = files.filter((name) => /^[/\\](journal|work|\.env)([/\\]|$)/i.test(name));
  const sentinelPresent = readFileSync(path).includes(Buffer.from(sentinel));
  if (privateFiles.length || sentinelPresent) throw new Error(`Unsafe distribution: ${path}`);
  return { path, files: files.length, privateFiles: 0, sentinelPresent: false };
});
const npmCli = process.env['HORNBOOK_NPM_CLI'];
if (!npmCli) throw new Error('Set HORNBOOK_NPM_CLI to the installed npm-cli.js to inspect the npm channel too');
const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: app, encoding: 'utf8', windowsHide: true }))[0];
if (packed.files.some((file: { path: string }) => /^(journal|work|\.env)(\/|$)/i.test(file.path))) throw new Error('npm package contains private files');
// npm tarballs are gzip-compressed; inspect decompressed bytes for sentinel values.
const { gunzipSync } = await import('node:zlib');
if (gunzipSync(readFileSync(join(root, packed.filename))).includes(Buffer.from(sentinel))) throw new Error('npm package contains private fixture bytes');
const report = { desktop: results, npm: { file: join(root, packed.filename), files: packed.files.length, privateFiles: 0, sentinelPresent: false } };
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
