import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { LANGUAGES, languageInfo, type LanguageInfo } from '../../lib/languages';
import { sectionIdFor } from '../../lib/journal-config';
import type { SectionSummary } from '../../lib/api-types';
import { ApiService } from '../api.service';
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
          <span aria-hidden="true">{{ targetInfo()?.flag }} → {{ learnerInfo()?.flag }}</span>
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
}
