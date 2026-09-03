import { Component, computed, effect, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { JournalService } from '../journal.service';
import { SectionService } from '../section.service';

/**
 * Home: the language pairs of this journal. With exactly one pair the user
 * lands in it directly; with none, the page points at /setup.
 */
@Component({
  selector: 'app-sections',
  imports: [RouterLink],
  template: `
    <section class="il-panel" style="padding-top: 2rem;">
      <div class="il-panel-inner" style="max-width: 860px; margin: 0 auto;">
        <h1 class="il-section-title">Language pairs</h1>
        <p class="il-section-sub">Each pair keeps its own lessons, glossary, cards, cheat sheet and progress.</p>

        @if (sections().length === 0) {
          <div class="il-card" style="margin-top: 1.5rem; padding: 1.5rem;">
            <p style="color: var(--ink-2); margin-bottom: 1rem;">No pairs yet. Pick the language you study and the language of your notes.</p>
            <a routerLink="/setup" class="il-btn">Create the first pair</a>
          </div>
        } @else {
          <div class="il-section-grid">
            @for (s of sections(); track s.id) {
              <a [routerLink]="['/', s.id]" class="il-card il-section-card">
                <div class="il-section-flags" aria-hidden="true">{{ s.flags.target }} <span class="il-section-arrow">→</span> {{ s.flags.learner }}</div>
                <div class="il-section-label">{{ s.label }}</div>
                <div class="il-stat-sub">{{ s.lessonCount }} {{ s.lessonCount === 1 ? 'lesson' : 'lessons' }} · {{ s.id }}</div>
              </a>
            }
            <a routerLink="/setup" class="il-card il-section-card il-section-card--new">
              <div class="il-section-flags" aria-hidden="true">＋</div>
              <div class="il-section-label">New pair</div>
              <div class="il-stat-sub">any target, any notes language</div>
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
