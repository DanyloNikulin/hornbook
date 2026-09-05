import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JobsService } from './jobs.service';
import { ApiService } from './api.service';
import { SectionService } from './section.service';
import type { JobView } from '../lib/api-types';

const job = (id: string, status: JobView['status'] = 'running'): JobView => ({ id, status, section: 'es-en', kind: 'cheatsheet', label: id, log: '', createdAt: '' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let get: ReturnType<typeof vi.fn>; let post: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); get = vi.fn(); post = vi.fn();
  TestBed.configureTestingModule({ providers: [
    { provide: ApiService, useValue: { get, post } },
    { provide: SectionService, useValue: { id: () => 'es-en' } },
  ] });
});
afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });
it('settles a stopped in-flight observation and cannot recreate its timer', async () => {
  const result = deferred<JobView>(); get.mockReturnValue(result.promise);
  const service = TestBed.inject(JobsService); const sink = vi.fn();
  const pending = service.observe('a', sink).catch((error: Error) => error.name);
  service.stop(); expect(await pending).toBe('AbortError');
  result.resolve(job('a')); await vi.advanceTimersByTimeAsync(5000);
  expect(get).toHaveBeenCalledTimes(1); expect(sink).not.toHaveBeenCalled();
});
it('shares a poll while allowing one subscriber to detach independently', async () => {
  const result = deferred<JobView>(); get.mockReturnValue(result.promise);
  const service = TestBed.inject(JobsService); const controller = new AbortController();
  const a = service.observe('a', undefined, controller.signal).catch((error: Error) => error.name);
  const b = service.observe('a'); controller.abort();
  expect(await a).toBe('AbortError'); expect(get).toHaveBeenCalledTimes(1);
  result.resolve(job('a', 'done')); expect((await b).status).toBe('done');
});
it('lets simultaneous jobs finish without an older job replacing the current view', async () => {
  post.mockResolvedValueOnce(job('a')).mockResolvedValueOnce(job('b'));
  const a = deferred<JobView>(); const b = deferred<JobView>();
  get.mockImplementation((path: string) => path.endsWith('/a') ? a.promise : b.promise);
  const service = TestBed.inject(JobsService);
  const first = service.run({ kind: 'cheatsheet' }); const second = service.run({ kind: 'cheatsheet' });
  await Promise.resolve(); await Promise.resolve();
  a.resolve(job('a', 'done')); await first;
  expect(service.current()?.id).toBe('b');
  b.resolve(job('b', 'done')); expect((await second).id).toBe('b');
});
it('stopping before a delayed start response prevents polling', async () => {
  const result = deferred<JobView>(); post.mockReturnValue(result.promise);
  const service = TestBed.inject(JobsService);
  const pending = service.run({ kind: 'cheatsheet' }).catch((error: Error) => error.name);
  service.stop(); result.resolve(job('a')); expect(await pending).toBe('AbortError');
  expect(get).not.toHaveBeenCalled(); expect(service.current()).toBeNull();
});
it('does not schedule a poll after a subscriber stops during its update', async () => {
  get.mockResolvedValue(job('a')); const service = TestBed.inject(JobsService);
  const pending = service.observe('a', () => service.stop()).catch((error: Error) => error.name);
  expect(await pending).toBe('AbortError'); await vi.advanceTimersByTimeAsync(5000);
  expect(get).toHaveBeenCalledTimes(1);
});
