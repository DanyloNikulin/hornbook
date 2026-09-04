import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobView } from '../lib/api-types';
import { ApiService } from './api.service';
import { I18nService } from './i18n.service';
import { JobsService } from './jobs.service';
import { SectionService } from './section.service';

const started: JobView = {
  id: 'job-1',
  section: 'es-en',
  kind: 'process',
  status: 'queued',
  label: 'lesson.mp4',
  log: '',
  createdAt: '2026-09-04T14:02:11.000Z',
};

function serviceWith(done: JobView): JobsService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: { post: vi.fn().mockResolvedValue(started), get: vi.fn().mockResolvedValue(done) } },
      { provide: SectionService, useValue: { apiBase: () => '/api/sections/es-en' } },
      { provide: I18nService, useValue: { t: (key: string, vars?: { label?: string }) => `${key}:${vars?.label ?? ''}` } },
    ],
  });
  return TestBed.inject(JobsService);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JobsService notifications', () => {
  it('notifies when a followed job ends while the document is hidden', async () => {
    const shown = vi.fn();
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = vi.fn().mockResolvedValue('granted');
      constructor(title: string, options?: NotificationOptions) {
        shown(title, options);
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const done = { ...started, status: 'done' as const, finishedAt: '2026-09-04T14:06:23.000Z' };

    await serviceWith(done).run({
      kind: 'process',
      filename: 'lesson.mp4',
      base64: '',
      date: '2026-09-04',
      from: 'video',
    });

    expect(shown).toHaveBeenCalledWith('job.notificationTitle:', {
      body: 'job.notificationDone:lesson.mp4',
      tag: 'hornbook-job-job-1',
    });
  });

  it('does not interrupt the foreground page with a duplicate notification', async () => {
    const shown = vi.fn();
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = vi.fn().mockResolvedValue('granted');
      constructor(title: string, options?: NotificationOptions) {
        shown(title, options);
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const failed = { ...started, status: 'failed' as const, error: 'bad file', finishedAt: '2026-09-04T14:06:23.000Z' };

    await serviceWith(failed).run({
      kind: 'process',
      filename: 'lesson.mp4',
      base64: '',
      date: '2026-09-04',
      from: 'video',
    });

    expect(shown).not.toHaveBeenCalled();
  });
});
