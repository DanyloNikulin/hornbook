import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import {
  EMPTY_PROGRESS,
  Progress,
  type DailyStateT,
  type ProgressT,
  type QuizResultT,
  type Sm2StateT,
} from '../lib/schema';
import type { ProgressView } from '../lib/api-types';
import { ApiService, ApiError } from './api.service';
import { ProgressDrafts } from './progress-drafts.service';

type LoadState = 'unloaded' | 'loading' | 'ready' | 'failed';
type DraftState =
  { status: 'ready' } | { status: 'unreadable' | 'disabled' | 'failed'; error: string };
interface Entry {
  id: string;
  state: LoadState;
  value: ProgressT;
  revision: string;
  journal: string;
  version: number;
  acknowledged: number;
  loading?: Promise<void>;
  pending?: Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
  loadError: string | null;
  saveError: string | null;
  draft: DraftState;
  recovery?: string;
  conflict: boolean;
}
export interface ProgressNotice {
  id: string;
  message: string;
  recovery: boolean;
  conflict: boolean;
  dirty: boolean;
  draftRecovery: boolean;
  draftDisabled: boolean;
}

@Injectable({ providedIn: 'root' })
export class ProgressStore {
  private readonly api = inject(ApiService);
  private readonly drafts = inject(ProgressDrafts);
  private readonly entries = new Map<string, Entry>();
  readonly sectionId = signal<string | null>(null);
  readonly state = signal<LoadState>('unloaded');
  readonly canStudy = signal(false);
  readonly sm2 = signal<Record<string, Sm2StateT>>({});
  readonly daily = signal<DailyStateT | null>(null);
  readonly quiz = signal<Record<string, QuizResultT>>({});
  readonly activity = signal<Record<string, number>>({});
  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly notices = signal<ProgressNotice[]>([]);
  readonly dirty = signal(false);

  constructor() {
    const close = (event: BeforeUnloadEvent) => {
      if (
        [...this.entries.values()].some(
          (entry) =>
            entry.version !== entry.acknowledged &&
            (!globalThis.window?.hornbookDesktop || entry.draft.status !== 'ready'),
        )
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const online = () => {
      void this.flush();
    };
    window.addEventListener('beforeunload', close);
    window.addEventListener('online', online);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('beforeunload', close);
      window.removeEventListener('online', online);
      for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
    });
  }

  private path(id: string): string {
    return `/api/sections/${encodeURIComponent(id)}/progress`;
  }
  private publish(): void {
    const entry = this.entries.get(this.sectionId() ?? '');
    this.state.set(entry?.state ?? 'unloaded');
    this.canStudy.set(entry?.state === 'ready' && entry.draft.status !== 'unreadable');
    this.apply(entry?.value ?? structuredClone(EMPTY_PROGRESS));
    this.loadError.set(entry?.loadError ?? null);
    this.saveError.set(
      entry?.saveError ?? (entry && entry.draft.status !== 'ready' ? entry.draft.error : null),
    );
    this.dirty.set(
      [...this.entries.values()].some((value) => value.version !== value.acknowledged),
    );
    this.notices.set(
      [...this.entries.values()]
        .filter(
          (value) =>
            value.loadError || value.saveError || value.draft.status !== 'ready' || value.recovery,
        )
        .map((value) => ({
          id: value.id,
          message:
            value.loadError ??
            value.saveError ??
            (value.draft.status !== 'ready' ? value.draft.error : value.recovery!),
          recovery: !!value.recovery,
          conflict: value.conflict,
          dirty: value.version !== value.acknowledged,
          draftRecovery: value.draft.status === 'unreadable',
          draftDisabled: value.draft.status === 'disabled',
        })),
    );
  }
  private apply(value: ProgressT): void {
    this.sm2.set(value.sm2);
    this.daily.set(value.daily);
    this.quiz.set(value.quiz);
    this.activity.set(value.activity);
  }

  async load(id: string, activate = true): Promise<void> {
    const prior = this.entries.get(this.sectionId() ?? '');
    if (activate && prior && prior.id !== id) void this.drain(prior);
    if (activate) this.sectionId.set(id);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        id,
        state: 'unloaded',
        value: structuredClone(EMPTY_PROGRESS),
        revision: '',
        journal: '',
        version: 0,
        acknowledged: 0,
        loadError: null,
        saveError: null,
        draft: { status: 'ready' },
        conflict: false,
      };
      this.entries.set(id, entry);
    }
    this.publish();
    if (entry.state === 'loading') return entry.loading;
    if (entry.state === 'ready' || entry.version !== entry.acknowledged) return;
    const selected = entry;
    selected.state = 'loading';
    selected.loadError = null;
    this.publish();
    selected.loading = this.api
      .get<ProgressView>(this.path(id))
      .then((view) => {
        if (!view.revision || !view.journalKey)
          throw new Error('Progress response has no revision');
        selected.value = Progress.parse(view);
        selected.revision = view.revision;
        selected.journal = view.journalKey;
        selected.recovery = view.recovery;
        selected.state = view.recovery ? 'failed' : 'ready';
        this.restoreDraft(selected, view);
      })
      .catch((error: unknown) => {
        selected.state = 'failed';
        selected.loadError = (error as Error).message;
      })
      .finally(() => {
        selected.loading = undefined;
        this.publish();
      });
    return selected.loading;
  }

  private restoreDraft(selected: Entry, view: ProgressView): void {
    selected.draft = { status: 'ready' };
    try {
      const draft = this.drafts.read(view.journalKey, selected.id);
      if (draft) {
        const same = JSON.stringify(draft.snapshot) === JSON.stringify(selected.value);
        if (same && !view.recovery) this.clearDraft(selected);
        else {
          selected.value = draft.snapshot;
          selected.revision = draft.revision;
          selected.version++;
          selected.conflict = draft.revision !== view.revision || !!view.recovery;
          selected.saveError = selected.conflict
            ? 'Saved progress changed while this copy was pending.'
            : null;
          if (!selected.conflict) void this.drain(selected);
        }
      }
    } catch (error) {
      selected.draft = { status: 'unreadable', error: (error as Error).message };
    }
  }

  private change(patch: Partial<ProgressT>): void {
    const entry = this.entries.get(this.sectionId() ?? '');
    if (!entry || entry.state !== 'ready' || entry.draft.status === 'unreadable') return;
    entry.value = structuredClone({ ...entry.value, ...patch });
    entry.version++;
    this.persist(entry);
    this.publish();
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.drain(entry);
    }, 400);
  }
  private persist(entry: Entry): void {
    if (entry.draft.status === 'disabled' || entry.draft.status === 'unreadable') return;
    try {
      this.drafts.write(entry.journal, entry.id, {
        revision: entry.revision,
        snapshot: entry.value,
      });
      entry.draft = { status: 'ready' };
    } catch (error) {
      entry.draft = { status: 'failed', error: (error as Error).message };
    }
  }
  private clearDraft(entry: Entry): void {
    if (entry.draft.status === 'disabled') return;
    try {
      this.drafts.write(entry.journal, entry.id, null);
      entry.draft = { status: 'ready' };
    } catch (error) {
      entry.draft = { status: 'failed', error: (error as Error).message };
    }
  }
  setSm2(sm2: Record<string, Sm2StateT>): void {
    this.change({ sm2 });
  }
  setDaily(daily: DailyStateT | null): void {
    this.change({ daily });
  }
  setQuiz(quiz: Record<string, QuizResultT>): void {
    this.change({ quiz });
  }
  setActivity(activity: Record<string, number>): void {
    this.change({ activity });
  }
  snapshot(): ProgressT {
    return structuredClone({
      sm2: this.sm2(),
      daily: this.daily(),
      quiz: this.quiz(),
      activity: this.activity(),
    });
  }

  private drain(entry: Entry): Promise<boolean> {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.pending) return entry.pending;
    if (entry.state !== 'ready' || entry.conflict || entry.draft.status === 'unreadable')
      return Promise.resolve(false);
    const run = async () => {
      while (entry.version !== entry.acknowledged) {
        const version = entry.version;
        const snapshot = structuredClone(entry.value);
        try {
          const result = await this.api.put<ProgressView>(this.path(entry.id), {
            ...snapshot,
            revision: entry.revision,
          });
          if (!result.revision) throw new Error('Save response has no revision');
          entry.revision = result.revision;
          entry.acknowledged = version;
          entry.saveError = null;
          if (entry.version !== version) this.persist(entry);
          else this.clearDraft(entry);
        } catch (error) {
          entry.saveError = (error as Error).message;
          entry.conflict = error instanceof ApiError && error.status === 409;
          this.persist(entry);
          return false;
        } finally {
          this.publish();
        }
      }
      return true;
    };
    entry.pending = run().finally(() => {
      entry.pending = undefined;
      this.publish();
    });
    return entry.pending;
  }

  async flush(): Promise<boolean> {
    const results = await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        do {
          if (!(await this.drain(entry))) return false;
        } while (entry.version !== entry.acknowledged);
        return true;
      }),
    );
    return results.every(Boolean);
  }
  async retry(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry?.state === 'loading') return;
    if (entry && entry.draft.status !== 'ready' && entry.version === entry.acknowledged) {
      entry.state = 'unloaded';
      await this.load(id, false);
      return;
    }
    if (entry?.state === 'ready') {
      entry.conflict = false;
      await this.drain(entry);
    } else await this.load(id, false);
  }
  async externalChange(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.loading) await entry.loading;
    if (entry.pending) await entry.pending;
    if (entry.version !== entry.acknowledged) {
      entry.conflict = true;
      entry.saveError =
        'Imported progress changed the saved history. Your unsaved copy is retained.';
      this.publish();
      return;
    }
    entry.state = 'unloaded';
    await this.load(id, false);
  }
  async startFresh(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.recovery || entry.state === 'loading' || entry.version !== entry.acknowledged)
      return;
    entry.state = 'loading';
    this.publish();
    try {
      const result = await this.api.put<ProgressView>(this.path(id), {
        ...structuredClone(EMPTY_PROGRESS),
        revision: entry.revision,
        recover: true,
      });
      if (!result.revision) throw new Error('Recovery response has no revision');
      entry.revision = result.revision;
      entry.recovery = undefined;
      entry.state = 'ready';
      entry.loadError = null;
    } catch (error) {
      entry.state = 'failed';
      entry.loadError = (error as Error).message;
    }
    this.publish();
  }
  async useSaved(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.state === 'loading') return;
    const previousState = entry.state;
    entry.state = 'loading';
    this.publish();
    if (entry.pending) await entry.pending;
    try {
      const view = await this.api.get<ProgressView>(this.path(id));
      const value = Progress.parse(view);
      if (!view.revision || !view.journalKey) throw new Error('Progress response has no revision');
      entry.value = value;
      entry.revision = view.revision;
      entry.journal = view.journalKey;
      entry.acknowledged = entry.version;
      entry.conflict = false;
      entry.saveError = null;
      entry.loadError = null;
      // A storage failure must not prevent the user's explicit choice of server progress.
      try {
        this.drafts.write(view.journalKey, id, null);
        entry.draft = { status: 'ready' };
      } catch (error) {
        entry.draft = { status: 'disabled', error: (error as Error).message };
      }
      entry.recovery = view.recovery;
      entry.state = view.recovery ? 'failed' : 'ready';
    } catch (error) {
      entry.state = previousState;
      entry.saveError = (error as Error).message;
    }
    this.publish();
  }
  exportPending(id: string): string {
    return JSON.stringify(this.entries.get(id)?.value ?? EMPTY_PROGRESS, null, 2);
  }
}
