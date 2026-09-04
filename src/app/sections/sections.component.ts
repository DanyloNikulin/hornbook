import { Component, computed, effect, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TPipe } from '../i18n.pipe';
import { JournalService } from '../journal.service';
import { SectionService } from '../section.service';

/**
 * Home: the language pairs of this journal. With exactly one pair the user
 * lands in it directly; with none, the page points at /setup.
 */
@Component({
  selector: 'app-sections',
  imports: [RouterLink, TPipe],
  template: `
    <section class="il-panel" style="padding-top: 2rem;">
      <div class="il-panel-inner" style="max-width: 860px; margin: 0 auto;">
        <h1 class="il-section-title">{{ 'pairs.title' | t }}</h1>
        <p class="il-section-sub">{{ 'pairs.sub' | t }}</p>

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
  private readonly router = inject(Router);

  protected readonly sections = computed(() => this.journal.sections());

  constructor() {
    this.section.set(null);
    // One pair only: no reason to make the user click through a list.
    effect(() => {
      const list = this.sections();
      if (this.journal.loaded() && list.length === 1) {
        void this.router.navigate(['/', list[0].id], { replaceUrl: true });
      }
    });
  }
}
