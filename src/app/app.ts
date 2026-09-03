import { Component, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs/operators';
import { REPO_URL } from './constants';
import { JournalService } from './journal.service';
import { SectionService } from './section.service';

type Theme = 'night' | 'day';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app.html',
})
export class AppComponent {
  protected readonly router = inject(Router);
  private readonly journal = inject(JournalService);
  protected readonly section = inject(SectionService);
  protected readonly repoUrl = REPO_URL;
  protected readonly brandName = computed(() => this.journal.brandName());
  protected readonly tagline = computed(() => this.journal.tagline());
  protected readonly sections = computed(() => this.journal.sections());
  protected readonly serverError = computed(() => this.journal.loadError());

  protected readonly theme = signal<Theme>(this.savedTheme());
  protected readonly menuOpen = signal(false);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  // Section pages show the section nav; home and setup show only the brand.
  protected readonly inSection = computed(() => {
    const path = this.url().split('?')[0];
    return this.section.current() !== null && path !== '/' && !path.startsWith('/setup');
  });

  protected readonly isCheatsheet = computed(() => this.url().split('?')[0].endsWith('/cheatsheet'));

  constructor() {
    const router = this.router;
    effect(() => {
      const t = this.theme();
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('hornbook-theme', t);
    });

    // Close mobile menu on any navigation
    router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.menuOpen.set(false));
  }

  protected toggleTheme(): void {
    this.theme.update((t) => (t === 'night' ? 'day' : 'night'));
  }

  protected toggleMenu(): void {
    this.menuOpen.update((v) => !v);
  }

  /** Switch to another section, keeping the same page when it exists there. */
  protected switchSection(id: string): void {
    const path = this.url().split('?')[0];
    const rest = path.split('/').slice(2).join('/');
    // Lesson slugs are section-specific; land on the section home instead.
    const target = rest.startsWith('lesson/') ? [] : rest ? [rest] : [];
    void this.router.navigate(['/', id, ...target]);
  }

  private savedTheme(): Theme {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem('hornbook-theme') : null;
    if (s === 'night' || s === 'day') return s;
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'night'
      : 'day';
  }
}
