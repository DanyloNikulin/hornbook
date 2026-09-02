import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SETUP_LANGUAGE_CODES, languageName, type JournalConfigT } from '../../lib/journal-config';
import { JournalService } from '../journal.service';

@Component({
  selector: 'app-setup',
  imports: [FormsModule, RouterLink],
  template: `
    <section class="il-panel" style="padding-top: 2rem;">
      <div class="il-panel-inner" style="max-width: 640px; margin: 0 auto;">
        <p><a routerLink="/" class="il-lesson-bc-link">← Lessons</a></p>
        <h1 class="il-section-title">Language pair</h1>
        <p class="il-section-sub">
          One journal, one pair. Target is what you study; learner is the language of notes.
          This page downloads a new <code>journal.config.json</code> — replace the file in the repo root and in
          <code>src/lib/journal.config.json</code>, then restart.
        </p>
        <p class="il-stat-sub">Current: {{ journal.targetName() }} → {{ journal.learnerName() }}</p>

        <label style="display:block; margin: 1rem 0;">
          Target (taught)
          <select [(ngModel)]="target" style="display:block; margin-top: 6px; width: 100%;">
            @for (c of codes; track c) {
              <option [value]="c">{{ name(c) }} ({{ c }})</option>
            }
          </select>
        </label>
        <label style="display:block; margin: 1rem 0;">
          Learner (notes)
          <select [(ngModel)]="learner" style="display:block; margin-top: 6px; width: 100%;">
            @for (c of codes; track c) {
              <option [value]="c">{{ name(c) }} ({{ c }})</option>
            }
          </select>
        </label>
        <button type="button" class="il-btn" (click)="download()">Download journal.config.json</button>
      </div>
    </section>
  `,
})
export class SetupComponent {
  protected readonly journal = inject(JournalService);
  protected readonly codes = SETUP_LANGUAGE_CODES;
  protected target = this.journal.targetCode();
  protected learner = this.journal.learnerCode();

  protected name(code: string): string {
    return languageName(code);
  }

  protected download(): void {
    const next: JournalConfigT = {
      ...this.journal.config,
      pair: { target: this.target, learner: this.learner },
    };
    const blob = new Blob([JSON.stringify(next, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'journal.config.json';
    a.click();
  }
}
