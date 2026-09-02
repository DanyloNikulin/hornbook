import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

/**
 * Wildcard (`**`) route target. Without it an unknown URL made the router
 * throw NG04002 and render the nav over an empty <main> with no way home
 * (issue #70). Mirrors the "Lesson not found" panel in lesson-detail.
 */
@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <section
      class="max-w-2xl mx-auto px-6 py-24 text-center space-y-6"
      style="background: var(--paper); min-height: 100vh;"
    >
      <h1 class="font-display text-3xl font-semibold" style="color: var(--ink);">Page not found</h1>
      <p style="color: var(--ink-2);">
        There is no route
        <code class="font-mono text-sm px-1.5 py-0.5 rounded" style="background: var(--paper-2);">{{ path }}</code>.
      </p>
      <div class="flex gap-3 justify-center flex-wrap">
        <a routerLink="/" class="il-btn sm inline-block">← home</a>
        <a routerLink="/search" class="il-btn ghost sm inline-block">Search</a>
      </div>
    </section>
  `,
})
export class NotFoundComponent {
  protected readonly path = inject(Router).url;
}
