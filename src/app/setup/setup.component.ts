import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { LANGUAGES, languageInfo, type LanguageInfo } from '../../lib/languages';
import { sectionIdFor } from '../../lib/journal-config';
import type {
  ImportConflictStrategy,
  LessonImportConflict,
  SectionImportResult,
  SectionSummary,
} from '../../lib/api-types';
import { ApiError, ApiService, fileToBase64 } from '../api.service';
import { TPipe } from '../i18n.pipe';
import { JournalService } from '../journal.service';
import { SectionService } from '../section.service';

/** Create a language pair. Pick once; the pair becomes a section of the journal. */
@Component({
  selector: 'app-setup',
  imports: [FormsModule, RouterLink, TPipe],
  template: `
    <section class="il-panel" style="padding-top: 2rem;">
      <div class="il-panel-inner" style="max-width: 720px; margin: 0 auto;">
        <p><a routerLink="/" class="il-lesson-bc-link">{{ 'setup.back' | t }}</a></p>
        <h1 class="il-section-title">{{ 'setup.title' | t }}</h1>
        <p class="il-section-sub">{{ 'setup.sub' | t }}</p>

        <div class="il-transfer-card il-transfer-card--pair">
          <span class="il-transfer-mark" aria-hidden="true">ZIP</span>
          <div>
            <h2>{{ 'transfer.pairImportTitle' | t }}</h2>
            <p>{{ 'transfer.pairImportSub' | t }}</p>
          </div>
          @if (!importFile()) {
            <label class="il-file">
              <input class="il-file-native" type="file" accept=".zip,application/zip" [disabled]="importing()" (change)="onImportFile($event)" />
              <span class="il-btn ghost">{{ 'transfer.choosePairArchive' | t }}</span>
              <span class="il-file-name">{{ 'file.none' | t }}</span>
            </label>
          } @else if (importFile(); as file) {
            <div class="il-transfer-file">
              <span><strong>{{ file.name }}</strong><small>{{ formatBytes(file.size) }}</small></span>
              <button type="button" class="il-btn ghost sm" [disabled]="importing()" (click)="clearImport()">{{ 'compose.changeFile' | t }}</button>
            </div>
            @if (conflicts().length > 0) {
              <aside class="il-transfer-conflict" role="alert">
                <strong>{{ 'transfer.pairConflictTitle' | t: { n: conflicts().length } }}</strong>
                <p>{{ 'transfer.pairConflictSub' | t }}</p>
                <ul>
                  @for (conflict of conflicts().slice(0, 4); track conflict.incomingId) {
                    <li><code>{{ conflict.incomingId }}</code></li>
                  }
                </ul>
                <div class="il-compose-actions">
                  <button type="button" class="il-btn" [disabled]="importing()" (click)="importPair('keep-both')">{{ 'transfer.keepBothAll' | t }}</button>
                  <button type="button" class="il-btn danger" [disabled]="importing()" (click)="importPair('replace')">{{ 'transfer.replaceAll' | t }}</button>
                </div>
              </aside>
            } @else {
              <button type="button" class="il-btn" [disabled]="importing()" (click)="importPair()">
                {{ importing() ? ('transfer.importing' | t) : ('transfer.importPairAction' | t) }}
              </button>
            }
          }
          @if (importError()) { <p class="il-compose-message il-compose-message--error" role="alert">{{ importError() }}</p> }
        </div>

        <div class="il-transfer-divider"><span>{{ 'transfer.orCreate' | t }}</span></div>

        <div class="il-pair-pick">
          <label class="il-pair-col">
            <span class="il-pair-head">{{ 'setup.target' | t }}</span>
            <div class="il-lang-list" role="listbox" [attr.aria-label]="'setup.target' | t">
              @for (l of languages; track l.code) {
                <button type="button" class="il-lang-option" [class.selected]="target() === l.code"
                        role="option" [attr.aria-selected]="target() === l.code"
                        (click)="target.set(l.code)">
                  <span class="il-lang-flag" aria-hidden="true">{{ l.flag }}</span>
                  <span class="il-lang-native">{{ l.native }}</span>
                  <span class="il-lang-name">{{ l.name }}</span>
                </button>
              }
            </div>
          </label>
          <label class="il-pair-col">
            <span class="il-pair-head">{{ 'setup.learner' | t }}</span>
            <div class="il-lang-list" role="listbox" [attr.aria-label]="'setup.learner' | t">
              @for (l of languages; track l.code) {
                <button type="button" class="il-lang-option" [class.selected]="learner() === l.code"
                        role="option" [attr.aria-selected]="learner() === l.code"
                        (click)="learner.set(l.code)">
                  <span class="il-lang-flag" aria-hidden="true">{{ l.flag }}</span>
                  <span class="il-lang-native">{{ l.native }}</span>
                  <span class="il-lang-name">{{ l.name }}</span>
                </button>
              }
            </div>
          </label>
        </div>

        <div class="il-pair-preview">
          <span class="il-flag" aria-hidden="true">{{ targetInfo()?.flag }} → {{ learnerInfo()?.flag }}</span>
          <strong>{{ targetInfo()?.name }} → {{ learnerInfo()?.name }}</strong>
          <span class="il-stat-sub">{{ 'setup.folder' | t }} <code>{{ id() }}</code></span>
        </div>

        <label style="display:block; margin: 1rem 0;">
          {{ 'setup.titleOptional' | t }}
          <input type="text" [(ngModel)]="title" [placeholder]="'setup.titlePlaceholder' | t" style="display:block; margin-top:6px; width:100%;" />
        </label>

        @if (exists()) {
          <p style="color: var(--muted);">{{ 'setup.exists' | t }} <a [routerLink]="['/', id()]" class="hover:underline">{{ 'setup.openIt' | t }}</a>.</p>
        }
        @if (error()) {
          <p style="color: #a33;" role="alert">{{ error() }}</p>
        }

        <button type="button" class="il-btn" [disabled]="!valid() || saving()" (click)="create()">
          {{ saving() ? ('setup.creating' | t) : ('setup.create' | t) }}
        </button>
      </div>
    </section>
  `,
})
export class SetupComponent {
  private readonly api = inject(ApiService);
  private readonly journal = inject(JournalService);
  private readonly section = inject(SectionService);
  private readonly router = inject(Router);

  protected readonly languages: readonly LanguageInfo[] = LANGUAGES;
  protected readonly target = signal('es');
  protected readonly learner = signal('en');
  protected title = '';
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly importFile = signal<File | null>(null);
  protected readonly importing = signal(false);
  protected readonly conflicts = signal<readonly LessonImportConflict[]>([]);
  protected readonly importError = signal<string | null>(null);

  protected readonly targetInfo = computed(() => languageInfo(this.target()));
  protected readonly learnerInfo = computed(() => languageInfo(this.learner()));
  protected readonly id = computed(() => sectionIdFor(this.target(), this.learner()));
  protected readonly exists = computed(() => this.journal.section(this.id()) !== undefined);
  protected readonly valid = computed(() => this.target() !== this.learner() && !this.exists());

  constructor() {
    this.section.set(null);
  }

  protected async create(): Promise<void> {
    if (!this.valid()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const created = await this.api.post<SectionSummary>('/api/sections', {
        target: this.target(),
        learner: this.learner(),
        title: this.title.trim() || undefined,
      });
      await this.journal.refresh();
      await this.router.navigate(['/', created.id]);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.saving.set(false);
    }
  }

  protected onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.importFile.set(file);
      this.conflicts.set([]);
      this.importError.set(null);
    }
    input.value = '';
  }

  protected clearImport(): void {
    this.importFile.set(null);
    this.conflicts.set([]);
    this.importError.set(null);
  }

  protected formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  protected async importPair(strategy: ImportConflictStrategy = 'error'): Promise<void> {
    const file = this.importFile();
    if (!file || this.importing()) return;
    this.importing.set(true);
    this.importError.set(null);
    try {
      const result = await this.api.post<SectionImportResult>('/api/sections/import', {
        base64: await fileToBase64(file),
        conflict: strategy,
      });
      this.conflicts.set([]);
      await this.journal.refresh();
      await this.router.navigate(['/', result.section.id]);
    } catch (error) {
      const conflicts = error instanceof ApiError && error.status === 409 ? importConflicts(error.details) : [];
      this.conflicts.set(conflicts);
      if (conflicts.length === 0) this.importError.set((error as Error).message);
    } finally {
      this.importing.set(false);
    }
  }
}

function importConflicts(details: unknown): LessonImportConflict[] {
  if (!details || typeof details !== 'object') return [];
  const conflicts = (details as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(conflicts)) return [];
  return conflicts.flatMap((entry): LessonImportConflict[] => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    return typeof value['slug'] === 'string' && typeof value['incomingId'] === 'string' && typeof value['existingId'] === 'string'
      ? [{ slug: value['slug'], incomingId: value['incomingId'], existingId: value['existingId'] }]
      : [];
  });
}
