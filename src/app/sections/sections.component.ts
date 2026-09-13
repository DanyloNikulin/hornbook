import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TPipe } from '../i18n.pipe';
import { JournalService } from '../journal.service';
import { SectionService } from '../section.service';

/**
 * Home: always show the pair chooser, including with a single pair, so the
 * user can return here to create another one.
 */
@Component({
  selector: 'app-sections',
  imports: [RouterLink, TPipe],
  template: `
    <section class="il-panel">
      <div class="il-panel-inner">
        <header class="il-page-head">
          <h1 class="il-section-title">{{ 'pairs.title' | t }}</h1>
          <p class="il-section-sub">{{ 'pairs.sub' | t }}</p>
        </header>

        @if (sections().length === 0) {
          <div class="il-empty-state il-empty-state--journal">
            <span class="il-empty-mark" aria-hidden="true">01</span>
            <p class="il-empty-kicker">{{ 'pairs.emptyKicker' | t }}</p>
            <h2>{{ 'pairs.empty' | t }}</h2>
            <p>{{ 'pairs.emptySub' | t }}</p>
            <a routerLink="/setup" class="il-btn">{{ 'pairs.createFirst' | t }}</a>
          </div>
        } @else {
          <div class="il-section-grid">
            @for (s of sections(); track s.id) {
              <a [routerLink]="['/', s.id]" class="il-card il-section-card">
                <div class="il-section-flags" aria-hidden="true">{{ s.flags.target }} <span class="il-section-arrow">→</span> {{ s.flags.learner }}</div>
                <div class="il-section-label">{{ s.label }}</div>
                <div class="il-stat-sub">{{ 'count.lessons' | t: { n: s.lessonCount } }} · {{ s.id }}</div>
              </a>
            }
            <a routerLink="/setup" class="il-card il-section-card il-section-card--new">
              <div class="il-section-flags" aria-hidden="true">＋</div>
              <div class="il-section-label">{{ 'pairs.new' | t }}</div>
              <div class="il-stat-sub">{{ 'pairs.newSub' | t }}</div>
            </a>
          </div>
        }
      </div>
    </section>
  `,
})
export class SectionsComponent {
  private readonly journal = inject(JournalService);
  private readonly section = inject(SectionService);

  protected readonly sections = computed(() => this.journal.sections());

  constructor() {
    this.section.set(null);
  }
}
