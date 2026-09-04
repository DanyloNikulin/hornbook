import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseCheckView } from '../lib/api-types';
import { ApiService } from './api.service';
import { DesktopService } from './desktop.service';
import { UpdateService } from './update.service';

const current: ReleaseCheckView = {
  currentVersion: '0.1.0',
  checkedAt: '2026-09-04T12:00:00.000Z',
  available: false,
};

function setup(get: ReturnType<typeof vi.fn>): UpdateService {
  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: { get } },
      {
        provide: DesktopService,
        useValue: {
          initialize: vi.fn().mockResolvedValue(undefined),
          state: signal(null),
          update: signal(null),
          available: signal(false),
        },
      },
    ],
  });
  return TestBed.inject(UpdateService);
}

beforeEach(() => {
  TestBed.resetTestingModule();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UpdateService browser checks', () => {
  it('does not hold application initialization open for the release feed', async () => {
    let finish!: (value: ReleaseCheckView) => void;
    const get = vi.fn().mockReturnValue(new Promise<ReleaseCheckView>((resolve) => (finish = resolve)));
    const service = setup(get);

    await service.initialize();

    expect(get).toHaveBeenCalledWith('/api/update');
    expect(service.state().phase).toBe('checking');
    finish(current);
    await vi.waitFor(() => expect(service.state().phase).toBe('current'));
  });

  it('backs off for a day after a failed browser check', async () => {
    const get = vi.fn().mockRejectedValue(new Error('offline'));
    const service = setup(get);

    await service.initialize();
    await vi.waitFor(() => expect(service.state().phase).toBe('error'));

    expect(Date.parse(localStorage.getItem('hornbook-update-checked-at') ?? '')).toBeGreaterThan(0);
  });
});
