import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SectionSummary } from '../../lib/api-types';
import { ApiService } from '../api.service';
import { JournalService } from '../journal.service';
import { SectionService } from '../section.service';
import { JobsService } from '../jobs.service';
import { ThemeService } from '../theme.service';
import { SettingsComponent } from './settings.component';

const section = (id: string): SectionSummary => ({ id, target: id.slice(0, 2), learner: 'en', label: id, flags: { target: '', learner: '' }, lessonCount: 0 });
const settings = { providers: { transcribe: { driver: 'skip', model: '-' }, extract: { driver: 'ollama', model: 'test' } }, connections: {} };
const events = new Subject<NavigationStart>();
const api = { get: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => resolve = r); return { promise, resolve }; }
interface Actions { save(): Promise<void>; removeBackdrop(): Promise<void>; uploadBackdrop(event: Event): Promise<void> }

beforeEach(async () => {
  vi.resetAllMocks();
  api.get.mockResolvedValue(settings);
  await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: [
    { provide: ApiService, useValue: api },
    { provide: Router, useValue: { events, url: '/es-en/settings' } },
    { provide: JournalService, useValue: { refresh: vi.fn().mockResolvedValue(undefined) } },
    { provide: JobsService, useValue: { current: signal(null) } },
    { provide: ThemeService, useValue: { restore: vi.fn(), preview: vi.fn() } },
  ] }).overrideComponent(SettingsComponent, { set: { template: '', imports: [] } }).compileComponents();
  TestBed.inject(SectionService).set(section('es-en'));
});

it.each(['save', 'removeBackdrop'] as const)('does not publish a late %s after navigation or re-entry', async (action) => {
  const fixture = TestBed.createComponent(SettingsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  const response = deferred<SectionSummary>();
  api.patch.mockReturnValue(response.promise);
  api.delete.mockReturnValue(response.promise);
  const pending = (fixture.componentInstance as unknown as Actions)[action]();
  events.next(new NavigationStart(1, '/it-en/settings'));
  TestBed.inject(SectionService).set(section('it-en'));
  response.resolve({ ...section('es-en'), title: 'Late response' });
  await pending;
  expect(TestBed.inject(SectionService).id()).toBe('it-en');
  expect(TestBed.inject(ThemeService).restore).not.toHaveBeenCalled();
  expect(action === 'save' ? api.patch : api.delete).toHaveBeenCalledWith(action === 'save' ? '/api/sections/es-en' : '/api/sections/es-en/backdrop', ...(action === 'save' ? [expect.any(Object)] : []));
  fixture.destroy();
});

it('captures backdrop ownership before a delayed file read', async () => {
  const fixture = TestBed.createComponent(SettingsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(() => undefined);
  api.put.mockResolvedValue(section('es-en'));
  const pending = (fixture.componentInstance as unknown as Actions).uploadBackdrop({ target: { files: [new File(['synthetic'], 'test.png')], value: 'test.png' } } as unknown as Event);
  const reader = read.mock.contexts[0] as FileReader;
  events.next(new NavigationStart(2, '/it-en/compose'));
  TestBed.inject(SectionService).set(section('it-en'));
  Object.defineProperty(reader, 'result', { value: 'data:image/png;base64,c3ludGhldGlj' });
  reader.onload?.call(reader, new ProgressEvent('load') as ProgressEvent<FileReader>);
  await pending;
  expect(api.put).toHaveBeenCalledWith('/api/sections/es-en/backdrop', expect.any(Object));
  expect(TestBed.inject(SectionService).id()).toBe('it-en');
  read.mockRestore();
  fixture.destroy();
});

it('discards results when a route is left and re-entered with the same section', async () => {
  const fixture = TestBed.createComponent(SettingsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  const response = deferred<SectionSummary>();
  api.patch.mockReturnValue(response.promise);
  const pending = (fixture.componentInstance as unknown as Actions).save();
  events.next(new NavigationStart(3, '/es-en/compose'));
  events.next(new NavigationStart(4, '/es-en/settings'));
  response.resolve({ ...section('es-en'), title: 'Stale' });
  await pending;
  expect(TestBed.inject(SectionService).current()?.title).toBeUndefined();
  fixture.destroy();
});
