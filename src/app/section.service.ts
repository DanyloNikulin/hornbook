import { Injectable, computed, signal } from '@angular/core';
import type { SectionSummary } from '../lib/api-types';
import { languageName, pairLabel, speechLocale } from '../lib/journal-config';

/**
 * The section (language pair) the user is currently inside. Set by the
 * `:section` route guard before any section page activates, so components
 * can read it synchronously. Outside a section (home, setup) it is null.
 */
@Injectable({ providedIn: 'root' })
export class SectionService {
  readonly current = signal<SectionSummary | null>(null);

  /** Section id, or '' outside a section. */
  readonly id = computed(() => this.current()?.id ?? '');
  readonly label = computed(() => this.current()?.label ?? '');

  set(section: SectionSummary | null): void {
    this.current.set(section);
  }

  targetCode(): string {
    return this.current()?.target ?? '';
  }

  learnerCode(): string {
    return this.current()?.learner ?? '';
  }

  targetName(): string {
    return languageName(this.targetCode());
  }

  learnerName(): string {
    return languageName(this.learnerCode());
  }

  labels(): { fwd: string; rev: string } {
    return pairLabel(this.targetCode(), this.learnerCode());
  }

  speechLang(): string {
    return speechLocale(this.targetCode());
  }

  /** Router commands for a path inside the current section: link('lesson', slug). */
  link(...segments: readonly (string | number)[]): (string | number)[] {
    return ['/', this.id(), ...segments];
  }

  /** Router commands for the section home. */
  home(): (string | number)[] {
    return ['/', this.id()];
  }

  /** API prefix for the current section. */
  apiBase(): string {
    return `/api/sections/${encodeURIComponent(this.id())}`;
  }
}
