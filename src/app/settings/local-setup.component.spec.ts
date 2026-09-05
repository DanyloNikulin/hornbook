import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SettingsView, SetupView } from '../../lib/api-types';
import { ApiService } from '../api.service';
import { JournalService } from '../journal.service';
import { JobsService } from '../jobs.service';
import { LocalSetupComponent } from './local-setup.component';

const setup: SetupView = {
  platform: 'win32', toolsDir: 'synthetic', machine: { platform: 'win32', arch: 'x64', ramMb: 16000 },
  recommend: { whisperModel: 'small', whisperVariant: 'cpu', ollamaModel: 'qwen2.5:7b', note: 'Synthetic' },
  tools: [
    { id: 'whisper', installed: true, source: 'managed', path: 'synthetic-whisper.exe', detail: '' },
    { id: 'whisper-model', installed: true, source: 'managed', path: 'synthetic-small.bin', detail: '' },
    { id: 'ffmpeg', installed: true, source: 'system', path: 'synthetic-ffmpeg.exe', detail: '' },
    { id: 'ollama', installed: true, source: 'managed', running: true, detail: '' },
    { id: 'ollama-model', installed: true, source: 'managed', models: ['qwen2.5:7b'], detail: '' },
  ], commands: { ffmpeg: undefined, whisper: undefined, 'whisper-model': undefined, ollama: undefined, 'ollama-model': undefined },
  whisperModels: [], ollamaModels: [], ollama: { host: 'http://localhost:11434', running: true, managed: true },
};
const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
beforeEach(async () => {
  vi.resetAllMocks();
  api.get.mockResolvedValue(structuredClone(setup));
  api.post.mockResolvedValue({ ok: true, detail: 'Synthetic probe' });
  api.put.mockImplementation((_url, input) => Promise.resolve({ providers: input.providers, connections: {} }));
  await TestBed.configureTestingModule({ imports: [LocalSetupComponent], providers: [
    { provide: ApiService, useValue: api },
    { provide: JobsService, useValue: { setupJob: signal(null) } },
  ] }).overrideComponent(LocalSetupComponent, { set: { template: '', imports: [] } }).compileComponents();
});

it('verifies the actual installed models, persists them and publishes defaults immediately', async () => {
  const fixture = TestBed.createComponent(LocalSetupComponent);
  await fixture.whenStable();
  let emitted: SettingsView | undefined;
  fixture.componentInstance.activated.subscribe((value) => emitted = value);
  await (fixture.componentInstance as unknown as { activate(): Promise<void> }).activate();
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(api.post).toHaveBeenCalledWith('/api/settings/probe', expect.objectContaining({ job: 'transcribe', driver: 'whisper-cli', model: 'synthetic-small.bin' }));
  expect(TestBed.inject(JournalService).config().providers).toEqual(emitted?.providers);
  expect(emitted?.providers.extract.model).toBe('qwen2.5:7b');
  fixture.destroy();
});

it('does not activate or claim readiness when verification fails', async () => {
  api.post.mockResolvedValue({ ok: false, detail: 'Model unavailable' });
  const fixture = TestBed.createComponent(LocalSetupComponent);
  await fixture.whenStable();
  await (fixture.componentInstance as unknown as { activate(): Promise<void> }).activate();
  expect(api.put).not.toHaveBeenCalled();
  fixture.destroy();
});
