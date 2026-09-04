import { describe, expect, it, vi } from 'vitest';
import {
  formatBytes,
  installCommand,
  managedPaths,
  preferredWhisperModel,
  recommend,
  releaseAsset,
  resolveDownload,
  toolsDir,
} from './tools.ts';

describe('toolsDir', () => {
  it('honours HORNBOOK_TOOLS, else the platform data folder', () => {
    expect(toolsDir({ HORNBOOK_TOOLS: 'D:/tools' }, 'win32', 'C:/Users/x')).toMatch(/[\\/]tools$/);
    expect(toolsDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\Users\\x')).toBe(
      'C:\\Users\\x\\AppData\\Local\\Hornbook\\tools',
    );
    expect(toolsDir({}, 'darwin', '/Users/x')).toBe('/Users/x/Library/Application Support/Hornbook/tools');
    expect(toolsDir({ XDG_DATA_HOME: '/data' }, 'linux', '/home/x')).toBe('/data/hornbook/tools');
    expect(toolsDir({}, 'linux', '/home/x')).toBe('/home/x/.local/share/hornbook/tools');
  });
});

describe('managedPaths', () => {
  it('adds .exe on Windows and keeps the Linux Ollama layout', () => {
    const win = managedPaths('C:\\t', 'win32');
    expect(win.ffmpeg).toBe('C:\\t\\ffmpeg\\ffmpeg.exe');
    expect(win.whisper).toBe('C:\\t\\whisper\\whisper-cli.exe');
    expect(win.ollama).toBe('C:\\t\\ollama\\ollama.exe');
    expect(win.whisperModel('small')).toBe('C:\\t\\models\\whisper\\ggml-small.bin');
    const linux = managedPaths('/t', 'linux');
    expect(linux.ollama).toBe('/t/ollama/bin/ollama');
    expect(linux.ffmpeg).toBe('/t/ffmpeg/ffmpeg');
  });
});

describe('releaseAsset', () => {
  it('picks the archive per platform and variant', () => {
    expect(releaseAsset('whisper', 'win32', 'x64')).toBe('whisper-bin-x64.zip');
    expect(releaseAsset('whisper', 'win32', 'x64', 'cuda')).toBe('whisper-cublas-12.4.0-bin-x64.zip');
    expect(releaseAsset('whisper', 'darwin', 'arm64')).toBeUndefined();
    expect(releaseAsset('ollama', 'darwin', 'arm64')).toBe('ollama-darwin.tgz');
    expect(releaseAsset('ollama', 'linux', 'x64')).toBe('ollama-linux-amd64.tar.zst');
    expect(releaseAsset('ffmpeg', 'win32', 'x64')).toBe('ffmpeg-n9.0-latest-win64-gpl-9.0.zip');
    expect(releaseAsset('ffmpeg', 'darwin', 'x64')).toBeUndefined();
  });
});

describe('installCommand', () => {
  it('names the package manager line per platform', () => {
    expect(installCommand('ffmpeg', 'win32')).toBe('winget install Gyan.FFmpeg');
    expect(installCommand('whisper', 'darwin')).toBe('brew install whisper-cpp');
    expect(installCommand('whisper', 'win32')).toBeUndefined();
    expect(installCommand('ollama-model', 'linux', 'qwen2.5:7b')).toBe('ollama pull qwen2.5:7b');
  });
});

describe('recommend', () => {
  it('sizes the writing model by VRAM, then by RAM without a GPU', () => {
    const base = { platform: 'win32', arch: 'x64', ramMb: 64000 };
    expect(recommend({ ...base, gpu: { name: 'RTX', vramMb: 16000 } }).ollamaModel).toBe('qwen2.5:14b');
    expect(recommend({ ...base, gpu: { name: 'RTX', vramMb: 8151 } })).toMatchObject({ ollamaModel: 'qwen2.5:7b', whisperVariant: 'cuda', whisperModel: 'small' });
    expect(recommend({ ...base, gpu: { name: 'GTX', vramMb: 4000 } }).ollamaModel).toBe('qwen2.5:3b');
    expect(recommend({ ...base })).toMatchObject({ ollamaModel: 'qwen2.5:7b', whisperVariant: 'cpu' });
    expect(recommend({ ...base, ramMb: 8000 }).ollamaModel).toBe('qwen2.5:3b');
    expect(recommend({ platform: 'darwin', arch: 'arm64', ramMb: 32000, gpu: { name: 'x', vramMb: 8000 } }).whisperVariant).toBe('cpu');
  });
});

describe('preferredWhisperModel', () => {
  it('prefers small, then the larger ones, then the smallest', () => {
    expect(preferredWhisperModel(['tiny', 'small', 'medium'])).toBe('small');
    expect(preferredWhisperModel(['tiny', 'medium'])).toBe('medium');
    expect(preferredWhisperModel(['tiny'])).toBe('tiny');
    expect(preferredWhisperModel([])).toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('rounds to what a person reads', () => {
    expect(formatBytes(8361840)).toBe('8 MB');
    expect(formatBytes(487601967)).toBe('488 MB');
    expect(formatBytes(1469175900)).toBe('1.47 GB');
    expect(formatBytes(15_000_000_000)).toBe('15 GB');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('resolveDownload', () => {
  it('reads url, size and digest of the pinned GitHub asset', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/b4938');
      return jsonResponse({
        assets: [
          { name: 'other.zip', size: 1, browser_download_url: 'x', digest: 'sha256:' + 'a'.repeat(64) },
          { name: 'whisper-bin-x64.zip', size: 8361840, browser_download_url: 'https://github.com/dl/whisper-bin-x64.zip', digest: 'sha256:' + 'C2'.repeat(32) },
        ],
      });
    }) as unknown as typeof fetch;
    const plan = await resolveDownload('whisper', { platform: 'win32', arch: 'x64', fetch: fetchImpl });
    expect(plan).toMatchObject({
      tool: 'whisper',
      kind: 'archive',
      fileName: 'whisper-bin-x64.zip',
      url: 'https://github.com/dl/whisper-bin-x64.zip',
      sizeBytes: 8361840,
      sha256: 'c2'.repeat(32),
      version: 'b4938',
      variant: 'cpu',
    });
  });

  it('fails clearly when the asset or the platform is missing', async () => {
    const empty = vi.fn(async () => jsonResponse({ assets: [] })) as unknown as typeof fetch;
    await expect(resolveDownload('ollama', { platform: 'win32', arch: 'x64', fetch: empty })).rejects.toThrow(/no asset ollama-windows-amd64\.zip/);
    await expect(resolveDownload('ffmpeg', { platform: 'darwin', arch: 'arm64', fetch: empty })).rejects.toThrow(/use the command/);
    const down = vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    await expect(resolveDownload('whisper', { platform: 'win32', arch: 'x64', fetch: down })).rejects.toThrow(/HTTP 503/);
  });

  it('takes a whisper model checksum from the Hugging Face LFS pointer', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { path: 'ggml-tiny.bin', size: 77691713, lfs: { oid: 'be07'.repeat(16) } },
        { path: 'ggml-small.bin', size: 487601967, lfs: { oid: '1be3'.repeat(16) } },
      ]),
    ) as unknown as typeof fetch;
    const plan = await resolveDownload('whisper-model', { platform: 'win32', arch: 'x64', model: 'small', fetch: fetchImpl });
    expect(plan).toMatchObject({ kind: 'file', fileName: 'ggml-small.bin', sizeBytes: 487601967, sha256: '1be3'.repeat(16), model: 'small' });
    expect(plan.url).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin');
    await expect(resolveDownload('whisper-model', { platform: 'win32', arch: 'x64', model: 'huge', fetch: fetchImpl })).rejects.toThrow(/Unknown whisper model/);
  });

  it('sums the layers of an Ollama manifest and targets the given host', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://registry.ollama.ai/v2/library/qwen2.5/manifests/7b');
      return jsonResponse({ layers: [{ size: 4_000_000 }, { size: 500_000 }] });
    }) as unknown as typeof fetch;
    const plan = await resolveDownload('ollama-model', { platform: 'linux', arch: 'x64', model: 'qwen2.5:7b', fetch: fetchImpl, ollamaHost: 'http://127.0.0.1:11435' });
    expect(plan).toMatchObject({ kind: 'pull', model: 'qwen2.5:7b', sizeBytes: 4_500_000, url: 'http://127.0.0.1:11435/api/pull', version: '7b' });
    expect(plan.sha256).toBeUndefined();
  });
});
