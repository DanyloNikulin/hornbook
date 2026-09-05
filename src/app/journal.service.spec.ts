import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';
import { ApiService } from './api.service';
import { JournalService } from './journal.service';
import type { ConfigView } from '../lib/api-types';
import type { ProvidersT } from '../lib/journal-config';
import type { SettingsView } from '../lib/api-types';

it('does not let a config request begun before saving restore obsolete providers', async () => {
  let finish!: (config: ConfigView) => void;
  const request = new Promise<ConfigView>((resolve) => finish = resolve);
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { get: vi.fn().mockReturnValue(request) } }] });
  const journal = TestBed.inject(JournalService);
  const old = structuredClone(journal.config());
  const loading = journal.load();
  const providers: ProvidersT = { ...old.providers, transcribe: { driver: 'skip', model: '-' } };
  journal.publishProviders(providers);
  finish(old);
  await loading;
  expect(journal.config().providers).toEqual(providers);
});

it('reads persisted defaults when an older successful mutation arrives after a newer save', async () => {
  let finishOld!: (value: unknown) => void;
  const old: ProvidersT = { transcribe: { driver: 'skip', model: '-' }, extract: { driver: 'claude-cli', model: '-' } };
  const newer: ProvidersT = { transcribe: { driver: 'whisper-cli', model: 'new.bin' }, extract: { driver: 'codex-cli', model: '-' } };
  let persisted = old;
  const api = {
    put: vi.fn().mockImplementationOnce(() => new Promise((resolve) => finishOld = resolve)).mockImplementationOnce(() => {
      persisted = newer;
      return Promise.resolve({ providers: newer });
    }),
    get: vi.fn().mockImplementation(() => Promise.resolve({ providers: persisted, connections: {} })),
  };
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
  const journal = TestBed.inject(JournalService);
  const savingOld = journal.saveSettings({ providers: old });
  await journal.saveSettings({ providers: newer });
  expect(journal.config().providers).toEqual(newer);
  finishOld({ providers: old });
  await savingOld;
  expect(journal.config().providers).toEqual(newer);
});

it('ignores an old reconciliation read held across another completed save', async () => {
  let finishRead!: (value: SettingsView) => void;
  const api = { put: vi.fn().mockResolvedValue({}), get: vi.fn().mockImplementationOnce(() => new Promise((resolve) => finishRead = resolve)) };
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
  const journal = TestBed.inject(JournalService);
  const old = structuredClone(journal.config().providers);
  const first = journal.saveSettings({ providers: old });
  await Promise.resolve();
  const newer: ProvidersT = { ...old, extract: { driver: 'kimi-cli', model: '-' } };
  api.get.mockResolvedValue({ providers: newer, connections: {} });
  await journal.saveSettings({ providers: newer });
  finishRead({ providers: old, connections: {} } as SettingsView);
  expect(await first).toBeNull();
  expect(journal.config().providers).toEqual(newer);
});
