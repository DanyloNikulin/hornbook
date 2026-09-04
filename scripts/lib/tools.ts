// Local tools for the zero-cost path: ffmpeg, whisper.cpp and its models,
// Ollama and its models. Where Hornbook keeps the ones it manages, which
// pinned release each comes from, and what suits this machine. Pure apart
// from resolveDownload, which asks the release APIs through the fetch it is
// given, so tests stub them.

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type {
  DownloadPlan,
  MachineInfo,
  Recommendation,
  ToolId,
  WhisperVariant,
} from '../../src/lib/api-types.ts';

export type { DownloadPlan, MachineInfo, Recommendation, ToolId, WhisperVariant };

export const TOOL_IDS: readonly ToolId[] = ['ffmpeg', 'whisper', 'whisper-model', 'ollama', 'ollama-model'];

/** Releases Hornbook downloads from. Bump a tag here, and only here. */
export const PINS = {
  whisper: { repo: 'ggml-org/whisper.cpp', tag: 'b4938' },
  ollama: { repo: 'ollama/ollama', tag: 'v0.33.3' },
  // BtbN republishes "latest" in place; the asset name pins the ffmpeg line.
  ffmpeg: { repo: 'BtbN/FFmpeg-Builds', tag: 'latest', version: 'n9.0' },
  whisperModels: { repo: 'ggerganov/whisper.cpp' },
} as const;

export const WHISPER_MODELS = [
  { name: 'tiny', approxMb: 75 },
  { name: 'base', approxMb: 142 },
  { name: 'small', approxMb: 466 },
  { name: 'medium', approxMb: 1463 },
  { name: 'large-v3-turbo', approxMb: 1549 },
] as const;

export const OLLAMA_MODELS = [
  { name: 'qwen2.5:3b', approxMb: 1900, minVramMb: 0, vision: false },
  { name: 'gemma3:4b', approxMb: 3300, minVramMb: 4000, vision: true },
  { name: 'qwen2.5:7b', approxMb: 4466, minVramMb: 6000, vision: false },
  { name: 'qwen2.5:14b', approxMb: 9000, minVramMb: 12000, vision: false },
] as const;

export const DEFAULT_MANAGED_OLLAMA_PORT = 11435;

// ── Where managed tools live ─────────────────────────────────────────────────

/** Path helpers of the platform being described, not of the host: the server may describe Linux from Windows in tests. */
function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

export function toolsDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const override = env['HORNBOOK_TOOLS']?.trim();
  const path = pathFor(platform);
  if (override) return path.resolve(override);
  const { join } = path;
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'Hornbook', 'tools');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Hornbook', 'tools');
  return join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'hornbook', 'tools');
}

export interface ManagedPaths {
  ffmpegDir: string;
  ffmpeg: string;
  ffprobe: string;
  whisperDir: string;
  whisper: string;
  whisperModels: string;
  whisperModel: (name: string) => string;
  ollamaDir: string;
  ollama: string;
  ollamaModels: string;
  downloads: string;
  manifest: string;
}

export function managedPaths(dir: string, platform: NodeJS.Platform = process.platform): ManagedPaths {
  const { join } = pathFor(platform);
  const exe = platform === 'win32' ? '.exe' : '';
  const ollamaDir = join(dir, 'ollama');
  return {
    ffmpegDir: join(dir, 'ffmpeg'),
    ffmpeg: join(dir, 'ffmpeg', `ffmpeg${exe}`),
    ffprobe: join(dir, 'ffmpeg', `ffprobe${exe}`),
    whisperDir: join(dir, 'whisper'),
    whisper: join(dir, 'whisper', `whisper-cli${exe}`),
    whisperModels: join(dir, 'models', 'whisper'),
    whisperModel: (name) => join(dir, 'models', 'whisper', `ggml-${name}.bin`),
    ollamaDir,
    // The Linux archive keeps the binary under bin/ next to lib/; the others put it at the root.
    ollama: platform === 'linux' ? join(ollamaDir, 'bin', 'ollama') : join(ollamaDir, `ollama${exe}`),
    ollamaModels: join(dir, 'ollama-models'),
    downloads: join(dir, '_downloads'),
    manifest: join(dir, 'manifest.json'),
  };
}

/** Preferred whisper model among the managed files, when the user has not chosen one. */
export function preferredWhisperModel(present: readonly string[]): string | undefined {
  const order = ['small', 'medium', 'large-v3-turbo', 'base', 'tiny'];
  return order.find((n) => present.includes(n)) ?? present[0];
}

// ── Release assets per platform ──────────────────────────────────────────────

export function releaseAsset(
  tool: 'ffmpeg' | 'whisper' | 'ollama',
  platform: NodeJS.Platform,
  arch: string,
  variant: WhisperVariant = 'cpu',
): string | undefined {
  const x64 = arch === 'x64';
  const arm = arch === 'arm64';
  switch (tool) {
    case 'whisper':
      if (platform === 'win32' && x64) return variant === 'cuda' ? 'whisper-cublas-12.4.0-bin-x64.zip' : 'whisper-bin-x64.zip';
      if (platform === 'linux' && x64) return 'whisper-bin-ubuntu-x64.tar.gz';
      if (platform === 'linux' && arm) return 'whisper-bin-ubuntu-arm64.tar.gz';
      return undefined;
    case 'ollama':
      if (platform === 'win32' && x64) return 'ollama-windows-amd64.zip';
      if (platform === 'win32' && arm) return 'ollama-windows-arm64.zip';
      if (platform === 'darwin') return 'ollama-darwin.tgz';
      if (platform === 'linux' && x64) return 'ollama-linux-amd64.tar.zst';
      if (platform === 'linux' && arm) return 'ollama-linux-arm64.tar.zst';
      return undefined;
    case 'ffmpeg':
      if (platform === 'win32' && x64) return 'ffmpeg-n9.0-latest-win64-gpl-9.0.zip';
      if (platform === 'linux' && x64) return 'ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz';
      if (platform === 'linux' && arm) return 'ffmpeg-n9.0-latest-linuxarm64-gpl-9.0.tar.xz';
      return undefined;
  }
}

/** The line to paste in a terminal when there is no download for this platform, or as an alternative. */
export function installCommand(tool: ToolId, platform: NodeJS.Platform, model?: string): string | undefined {
  switch (tool) {
    case 'ffmpeg':
      return platform === 'win32' ? 'winget install Gyan.FFmpeg' : platform === 'darwin' ? 'brew install ffmpeg' : 'sudo apt install ffmpeg';
    case 'whisper':
      return platform === 'darwin' ? 'brew install whisper-cpp' : platform === 'linux' ? 'git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j' : undefined;
    case 'whisper-model':
      return `curl -L -o ggml-${model ?? 'small'}.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model ?? 'small'}.bin`;
    case 'ollama':
      return platform === 'win32' ? 'winget install Ollama.Ollama' : platform === 'darwin' ? 'brew install ollama' : 'curl -fsSL https://ollama.com/install.sh | sh';
    case 'ollama-model':
      return `ollama pull ${model ?? 'qwen2.5:7b'}`;
  }
}

/** File name looked for inside an extracted archive. */
export function executableName(tool: 'ffmpeg' | 'whisper' | 'ollama', platform: NodeJS.Platform): string {
  const exe = platform === 'win32' ? '.exe' : '';
  return tool === 'whisper' ? `whisper-cli${exe}` : `${tool}${exe}`;
}

// ── What suits this machine ──────────────────────────────────────────────────

export function recommend(m: MachineInfo): Recommendation {
  const vram = m.gpu?.vramMb ?? 0;
  const ollamaModel =
    vram >= 12000 ? 'qwen2.5:14b' : vram >= 6000 ? 'qwen2.5:7b' : m.gpu ? 'qwen2.5:3b' : m.ramMb >= 16000 ? 'qwen2.5:7b' : 'qwen2.5:3b';
  const cudaBuild = !!m.gpu && m.platform === 'win32' && m.arch === 'x64';
  return {
    whisperModel: 'small',
    whisperVariant: cudaBuild ? 'cuda' : 'cpu',
    ollamaModel,
    note: m.gpu
      ? `With ${Math.round(m.gpu.vramMb / 1024)} GB of GPU memory: ${ollamaModel} for writing, whisper small on the ${cudaBuild ? 'CUDA' : 'CPU'} build for hearing.`
      : `Without an NVIDIA GPU: ${ollamaModel} on the CPU (slow but works), whisper small on the CPU build.`,
  };
}

// ── Resolving a pinned release to a URL, size and checksum ──────────────────

export interface ResolveOptions {
  platform: NodeJS.Platform;
  arch: string;
  variant?: WhisperVariant;
  model?: string;
  fetch: typeof fetch;
  /** For the pull plan: the Ollama that will do the pulling. */
  ollamaHost?: string;
}

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'hornbook-setup',
  'X-GitHub-Api-Version': '2022-11-28',
};

interface GithubAsset {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string;
}

async function githubAsset(repo: string, tag: string, name: string, fetchImpl: typeof fetch): Promise<GithubAsset> {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetchImpl(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${repo} ${tag}.`);
  const json = (await res.json()) as { assets?: GithubAsset[] };
  const asset = (json.assets ?? []).find((a) => a.name === name);
  if (!asset) throw new Error(`Release ${repo} ${tag} has no asset ${name}.`);
  return asset;
}

function sha256FromDigest(digest: string | undefined): string | undefined {
  const m = digest?.match(/^sha256:([0-9a-f]{64})$/i);
  return m ? m[1].toLowerCase() : undefined;
}

export async function resolveDownload(tool: ToolId, opts: ResolveOptions): Promise<DownloadPlan> {
  switch (tool) {
    case 'ffmpeg':
    case 'whisper':
    case 'ollama': {
      const name = releaseAsset(tool, opts.platform, opts.arch, opts.variant);
      const pin = PINS[tool];
      if (!name) throw new Error(`No ${tool} download for ${opts.platform}/${opts.arch}; use the command instead.`);
      const asset = await githubAsset(pin.repo, pin.tag, name, opts.fetch);
      return {
        tool,
        kind: 'archive',
        fileName: asset.name,
        url: asset.browser_download_url,
        sizeBytes: asset.size,
        sha256: sha256FromDigest(asset.digest),
        source: `github.com/${pin.repo} ${pin.tag}`,
        version: 'version' in pin ? pin.version : pin.tag,
        variant: tool === 'whisper' ? (opts.variant ?? 'cpu') : undefined,
      };
    }
    case 'whisper-model': {
      const model = opts.model ?? 'small';
      if (!WHISPER_MODELS.some((m) => m.name === model)) throw new Error(`Unknown whisper model "${model}".`);
      const file = `ggml-${model}.bin`;
      const res = await opts.fetch(`https://huggingface.co/api/models/${PINS.whisperModels.repo}/tree/main`, {
        headers: { 'User-Agent': 'hornbook-setup' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Hugging Face answered HTTP ${res.status}.`);
      const rows = (await res.json()) as { path: string; size: number; lfs?: { oid?: string } }[];
      const row = rows.find((r) => r.path === file);
      if (!row) throw new Error(`Hugging Face lists no ${file}.`);
      return {
        tool,
        kind: 'file',
        fileName: file,
        url: `https://huggingface.co/${PINS.whisperModels.repo}/resolve/main/${file}`,
        sizeBytes: row.size,
        sha256: row.lfs?.oid?.match(/^[0-9a-f]{64}$/i) ? row.lfs.oid.toLowerCase() : undefined,
        source: `huggingface.co/${PINS.whisperModels.repo}`,
        version: model,
        model,
      };
    }
    case 'ollama-model': {
      const model = opts.model ?? 'qwen2.5:7b';
      const [name, tag = 'latest'] = model.split(':');
      const res = await opts.fetch(`https://registry.ollama.ai/v2/library/${name}/manifests/${tag}`, {
        headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json', 'User-Agent': 'hornbook-setup' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`ollama.com answered HTTP ${res.status} for ${model}.`);
      const manifest = (await res.json()) as { layers?: { size: number }[] };
      const size = (manifest.layers ?? []).reduce((a, l) => a + (l.size ?? 0), 0);
      return {
        tool,
        kind: 'pull',
        fileName: model,
        url: `${opts.ollamaHost ?? 'http://127.0.0.1:11434'}/api/pull`,
        sizeBytes: size,
        source: `ollama.com/library/${name}`,
        version: tag,
        model,
      };
    }
  }
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 2)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}
