import { describe, expect, it, vi } from 'vitest';
import { UpdateController } from './update-controller.ts';
import type { ReleaseCheckView } from '../src/lib/api-types.ts';

const release = (version: string): ReleaseCheckView => ({ currentVersion: '1.0.0', checkedAt: '2026-09-05T00:00:00Z', available: true, release: { version, name: version, notes: '', url: '' } });
function setup() {
  const discover = vi.fn().mockResolvedValue(release('1.1.0'));
  const prepare = vi.fn().mockResolvedValue(null);
  const ready = vi.fn();
  return { discover, prepare, ready, controller: new UpdateController({ currentVersion: '1.0.0', installable: true, discover, prepare, ready, publish: vi.fn() }) };
}

describe('installer ownership', () => {
  it('keeps a downloaded installer restartable through manual, cached and failed discovery', async () => {
    const { controller, discover, prepare, ready } = setup();
    await controller.check(false);
    controller.available('1.1.0'); controller.downloaded('1.1.0');
    await controller.check(false); await controller.check(true);
    discover.mockRejectedValue(new Error('offline'));
    await controller.check(true);
    expect(controller.state()).toMatchObject({ phase: 'ready', release: { version: '1.1.0' } });
    expect(prepare).toHaveBeenCalledTimes(1); expect(ready).toHaveBeenCalledTimes(1);
  });
  it('coalesces checks and does not restart a download when discovery repeats', async () => {
    const { controller, discover, prepare } = setup();
    let resolve!: (value: ReleaseCheckView) => void;
    discover.mockReturnValue(new Promise<ReleaseCheckView>((done) => { resolve = done; }));
    const a = controller.check(false); const b = controller.check(true);
    expect(a).toBe(b); expect(discover).toHaveBeenCalledTimes(1);
    resolve(release('1.1.0')); await a;
    controller.available('1.1.0'); controller.progress(41.7);
    await controller.check(true);
    expect(controller.state()).toMatchObject({ phase: 'downloading', progress: 42 });
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('retains the ready installer when a newer release is discovered', async () => {
    const { controller, discover, prepare } = setup();
    await controller.check(false); controller.available('1.1.0'); controller.downloaded('1.1.0');
    discover.mockResolvedValue(release('1.2.0')); await controller.check(true);
    controller.progress(10); controller.failed('late error'); controller.downloaded('1.0.1');
    expect(controller.state()).toMatchObject({ phase: 'ready', release: { version: '1.1.0' } });
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('retries a failed download and rejects stale versioned completion', async () => {
    const { controller, discover, prepare } = setup();
    await controller.check(false); controller.available('1.1.0'); controller.failed('download failed');
    expect(controller.state().error).toBe('download failed');
    discover.mockResolvedValue(release('1.2.0')); await controller.check(true);
    controller.available('1.2.0'); controller.downloaded('1.1.0');
    expect(controller.state().phase).toBe('downloading');
    controller.downloaded('1.2.0');
    expect(controller.state()).toMatchObject({ phase: 'ready', release: { version: '1.2.0' } });
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
