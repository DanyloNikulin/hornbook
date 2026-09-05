import type { DesktopUpdateState, ReleaseCheckView, ReleaseInfo } from '../src/lib/api-types.ts';
import { compareVersions } from '../server/releases.ts';

type Installer = { phase: 'checking' | 'downloading' | 'ready' | 'error'; release: ReleaseInfo; progress?: number; error?: string };
export interface UpdateControllerOptions {
  currentVersion: string;
  installable: boolean;
  discover(force: boolean): Promise<ReleaseCheckView>;
  prepare(): Promise<unknown>;
  publish(state: DesktopUpdateState): void;
  ready?(): void;
}

/** Release discovery never owns or clears a downloaded installer. */
export class UpdateController {
  private discovery?: ReleaseCheckView;
  private installer?: Installer;
  private checking = false;
  private flight?: Promise<DesktopUpdateState>;
  private preparing?: Promise<void>;

  constructor(private readonly options: UpdateControllerOptions) {}

  state(): DesktopUpdateState {
    const installer = this.installer;
    const base = { currentVersion: this.options.currentVersion, installable: this.options.installable, checkedAt: this.discovery?.checkedAt };
    if (installer?.phase === 'ready' || installer?.phase === 'downloading')
      return { ...base, phase: installer.phase, release: installer.release, progress: installer.progress };
    const release = this.discovery?.release ?? installer?.release;
    const available = release && compareVersions(release.version, base.currentVersion) > 0;
    return {
      ...base,
      phase: this.checking ? 'checking' : available ? 'available' : this.discovery?.error ? 'error' : this.discovery ? 'current' : 'idle',
      ...(available ? { release } : {}),
      ...(installer?.error || this.discovery?.error ? { error: installer?.error ?? this.discovery?.error } : {}),
    };
  }

  check(force: boolean): Promise<DesktopUpdateState> {
    if (this.flight) return this.flight;
    this.checking = true;
    this.publish();
    this.flight = this.discover(force).finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private async discover(force: boolean): Promise<DesktopUpdateState> {
    try {
      this.discovery = await this.options.discover(force);
    } catch (error) {
      this.discovery = { currentVersion: this.options.currentVersion, available: false, checkedAt: new Date().toISOString(), error: (error as Error).message };
    } finally {
      this.checking = false;
      this.publish();
    }
    if (this.installer?.phase === 'error') await this.preparing;
    if (!this.preparing && this.options.installable && this.discovery.available && this.discovery.release &&
        (!this.installer || this.installer.phase === 'error')) {
      this.installer = { phase: 'checking', release: this.discovery.release };
      // The updater emits versioned events; discovery may complete before download.
      this.preparing = Promise.resolve().then(() => this.options.prepare()).then(() => undefined)
        .catch((error: Error) => this.failed(error.message)).finally(() => { this.preparing = undefined; });
    }
    return this.state();
  }

  available(version: string): void {
    if (this.installer?.phase !== 'checking') return;
    if (compareVersions(version, this.options.currentVersion) <= 0) return;
    const release = this.discovery?.release?.version === version ? this.discovery.release :
      { version, name: `Hornbook ${version}`, notes: '', url: '' };
    this.installer = { phase: 'downloading', release, progress: 0 };
    this.publish();
  }

  unavailable(): void {
    if (this.installer?.phase !== 'checking') return;
    this.installer = undefined;
    this.publish();
  }

  progress(percent: number): void {
    if (this.installer?.phase !== 'downloading' || !Number.isFinite(percent)) return;
    this.installer.progress = Math.max(0, Math.min(100, Math.round(percent)));
    this.publish();
  }

  downloaded(version: string): void {
    if (!this.installer || this.installer.release.version !== version ||
        !['checking', 'downloading'].includes(this.installer.phase)) return;
    this.installer = { phase: 'ready', release: this.installer.release, progress: 100 };
    this.publish();
    this.options.ready?.();
  }

  failed(message: string): void {
    if (!this.installer || this.installer.phase === 'ready') return;
    this.installer = { phase: 'error', release: this.installer.release, error: message };
    this.publish();
  }

  private publish(): void { this.options.publish(this.state()); }
}
