import { Component, inject } from '@angular/core';
import { SectionService } from '../section.service';
import { Router, RouterLink } from '@angular/router';
import { TPipe } from '../i18n.pipe';

/**
 * Wildcard (`**`) route target. Without it an unknown URL made the router
 * throw NG04002 and render the nav over an empty <main> with no way home
 *. Mirrors the "Lesson not found" panel in lesson-detail.
 */
@Component({
  selector: 'app-not-found',
  imports: [RouterLink, TPipe],
  template: `
    <section
      class="max-w-2xl mx-auto px-6 py-24 text-center space-y-6"
      style="background: var(--paper); min-height: 100vh;"
    >
      <h1 class="font-display text-3xl font-semibold" style="color: var(--ink);">{{ 'notFound.title' | t }}</h1>
      <p style="color: var(--ink-2);">
        {{ 'notFound.noRoute' | t }}
        <code class="font-mono text-sm px-1.5 py-0.5 rounded" style="background: var(--paper-2);">{{ path }}</code>.
      </p>
      <div class="flex gap-3 justify-center flex-wrap">
        <a routerLink="/" class="il-btn sm inline-block">{{ 'common.home' | t }}</a>
        <a routerLink="/search" class="il-btn ghost sm inline-block">{{ 'nav.search' | t }}</a>
      </div>
    </section>
  `,
})
export class NotFoundComponent {
  protected readonly sec = inject(SectionService);
  protected readonly path = inject(Router).url;
}
