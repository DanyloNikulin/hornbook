import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposeComponent } from './compose.component';
import { SectionService } from '../section.service';
import { SectionMutations } from '../section-mutations.service';
import { JobsService } from '../jobs.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
interface Editor {
  title: string;
  date: string;
  transcript: string;
  pickedFile: { set(file: File): void };
  save(): Promise<void>;
  startFile(): Promise<void>;
  submitTranscript(): Promise<void>;
}
let section: string;
let router: { url: string; events: Subject<NavigationStart>; navigate: ReturnType<typeof vi.fn> };
let mutations: { saveLesson: ReturnType<typeof vi.fn>; runJob: ReturnType<typeof vi.fn> };
function editor(): Editor {
  return TestBed.runInInjectionContext(() => new ComposeComponent()) as unknown as Editor;
}
function leave(): void {
  section = 'it-en';
  router.url = '/it-en/add';
  router.events.next(new NavigationStart(2, router.url));
}
beforeEach(() => {
  section = 'es-en';
  router = { url: '/es-en/add', events: new Subject(), navigate: vi.fn().mockResolvedValue(true) };
  mutations = { saveLesson: vi.fn(), runJob: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: Router, useValue: router },
      { provide: SectionService, useValue: { id: () => section } },
      { provide: SectionMutations, useValue: mutations },
      { provide: JobsService, useValue: { current: signal(null) } },
    ],
  });
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});
it('a save finishing after a section switch cannot navigate the new section', async () => {
  const response = deferred<{ slug: string }>();
  mutations.saveLesson.mockReturnValue(response.promise);
  const component = editor();
  component.title = 'A lesson';
  const save = component.save();
  leave();
  response.resolve({ slug: 'a-lesson' });
  await save;
  expect(mutations.saveLesson.mock.calls[0][0]).toBe('es-en');
  expect(router.navigate).not.toHaveBeenCalled();
});
it('a file read keeps its section, date and title even when the view changes before the job starts', async () => {
  const read = deferred<void>();
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:text/plain;base64,ZmFrZQ==';
      onload?: () => void;
      readAsDataURL() {
        void read.promise.then(() => this.onload?.());
      }
    },
  );
  mutations.runJob.mockResolvedValue({ status: 'done', result: { slug: 'a-lesson' } });
  const component = editor();
  component.title = 'Original title';
  component.date = '2026-01-01';
  component.pickedFile.set(new File(['fake'], 'a.txt'));
  const run = component.startFile();
  leave();
  component.title = 'Other title';
  component.date = '2026-02-01';
  read.resolve();
  await run;
  expect(mutations.runJob.mock.calls[0]).toEqual([
    'es-en',
    expect.objectContaining({ date: '2026-01-01', title: 'Original title' }),
  ]);
  expect(router.navigate).not.toHaveBeenCalled();
});
it('a running job finishing after navigation cannot redirect or overwrite the new view', async () => {
  const response = deferred<{ status: string; result: { slug: string } }>();
  mutations.runJob.mockReturnValue(response.promise);
  const component = editor();
  component.transcript = 'fixture';
  const run = component.submitTranscript();
  leave();
  response.resolve({ status: 'done', result: { slug: 'old-job' } });
  await run;
  expect(mutations.runJob.mock.calls[0][0]).toBe('es-en');
  expect(router.navigate).not.toHaveBeenCalled();
});
