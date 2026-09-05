import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';
import { ApiService } from './api.service';
import { JournalService } from './journal.service';
import type { ConfigView } from '../lib/api-types';
import type { ProvidersT } from '../lib/journal-config';

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
