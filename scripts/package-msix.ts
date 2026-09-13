#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build, Platform, Arch, type Configuration } from 'electron-builder';
import sharp from 'sharp';
import { msixIdentity, msixManifest, msixVersion, type MsixIdentity } from './lib/msix.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeAppx(): string {
  const explicit = process.env['HORNBOOK_MAKEAPPX'];
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`MakeAppx not found: ${explicit}`);
    return explicit;
  }
  const sdk = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = existsSync(sdk) ? readdirSync(sdk).filter((name) => /^10\.[\d.]+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
  for (const version of versions) {
    const tool = join(sdk, version, process.arch === 'arm64' ? 'arm64' : 'x64', 'makeappx.exe');
    if (existsSync(tool)) return tool;
  }
  throw new Error('Install the Windows 10/11 SDK or set HORNBOOK_MAKEAPPX to makeappx.exe.');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('npm run package:msix -- --preview [--arm64]\nWithout --preview, use build/microsoft-store.json or all four HORNBOOK_STORE_* identity values. Builds an unsigned package; never publishes or installs.');
    return;
  }
  if (args.some((arg) => !['--preview', '--arm64'].includes(arg))) throw new Error('Unknown argument. Use --help.');
  if (process.platform !== 'win32') throw new Error('MSIX packaging requires Windows.');
  const preview = args.includes('--preview');
  const arch = args.includes('--arm64') ? 'arm64' : 'x64';
  const identityEnv = { ...process.env };
  const identityFile = join(root, 'build', 'microsoft-store.json');
  if (!preview && existsSync(identityFile)) {
    const saved = JSON.parse(readFileSync(identityFile, 'utf8')) as MsixIdentity;
    const fields = {
      HORNBOOK_STORE_IDENTITY_NAME: saved.name,
      HORNBOOK_STORE_PUBLISHER: saved.publisher,
      HORNBOOK_STORE_PUBLISHER_DISPLAY_NAME: saved.publisherDisplayName,
      HORNBOOK_STORE_DISPLAY_NAME: saved.displayName,
    };
    // Override the complete identity together, never mix publishers or products.
    if (!Object.keys(fields).some((key) => identityEnv[key]?.trim())) Object.assign(identityEnv, fields);
  }
  const identity = msixIdentity(preview, identityEnv);
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  msixVersion(version);
  const packer = makeAppx();
  const outputRoot = join(root, 'release', 'msix');
  mkdirSync(outputRoot, { recursive: true });
  // Each invocation owns a new directory: no stale files and no recursive cleanup.
  const output = mkdtempSync(join(outputRoot, `${preview ? 'preview' : 'store'}-${arch}-`));
  const assets = join(output, 'assets');
  mkdirSync(assets);
  const base = createRequire(import.meta.url)('../electron-builder.config.cjs') as Configuration;
  const config: Configuration = {
    ...base,
    extends: null,
    directories: { ...base.directories, output: join(output, 'unpacked') },
    extraMetadata: { hornbookDistribution: 'microsoft-store', hornbookStorePreview: preview },
    win: { icon: 'build/icon.ico', extraResources: base.win?.extraResources, signExecutable: false },
    publish: null,
  };
  await build({ projectDir: root, config, targets: Platform.WINDOWS.createTarget(['dir'], arch === 'x64' ? Arch.x64 : Arch.arm64), publish: 'never' });
  const app = join(output, 'unpacked', arch === 'x64' ? 'win-unpacked' : 'win-arm64-unpacked');
  if (!existsSync(join(app, 'Hornbook.exe'))) throw new Error('Packaged executable missing.');
  for (const [name, size] of [['StoreLogo', 50], ['Square150x150Logo', 150], ['Square44x44Logo', 44]] as const) {
    await sharp(join(root, 'build', 'icon.png')).resize(size, size).png().toFile(join(assets, `${name}.png`));
  }
  const manifest = join(output, 'AppxManifest.xml');
  writeFileSync(manifest, msixManifest(identity, version, arch));
  const mappings = ['[Files]', `"${manifest}" "AppxManifest.xml"`];
  function mapFiles(dir: string, target: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = join(dir, entry.name);
      const destination = `${target}\\${entry.name}`;
      if (entry.isDirectory()) mapFiles(source, destination);
      else if (entry.isFile()) mappings.push(`"${source}" "${destination}"`);
      else throw new Error(`Unsupported package entry: ${source}`);
    }
  }
  mapFiles(app, 'app');
  mapFiles(assets, 'assets');
  const mapping = join(output, 'mapping.txt');
  writeFileSync(mapping, mappings.join('\r\n'));
  const artifact = join(output, `Hornbook-${version}-${preview ? 'preview' : 'store'}-${arch}.msix`);
  execFileSync(packer, ['pack', '/f', mapping, '/p', artifact, '/o'], { stdio: 'inherit', windowsHide: true });
  writeFileSync(join(output, 'build-info.json'), JSON.stringify({ artifact, app, identity, version: msixVersion(version), arch, preview, signed: false }, null, 2));
  console.log(`\nUnsigned MSIX: ${artifact}\n${preview ? 'Local test identity only. Do not submit to Store.' : 'Upload through Partner Center for certification and Microsoft signing.'}`);
}

main().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
