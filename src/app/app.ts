import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs/operators';
import { isStockTagline } from '../lib/i18n';
import { REPO_URL } from './constants';
import { TPipe } from './i18n.pipe';
import { JournalService } from './journal.service';
import { SectionService } from './section.service';
import { ThemeService } from './theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TPipe],
  templateUrl: './app.html',
})
export class AppComponent {
  protected readonly router = inject(Router);
  private readonly journal = inject(JournalService);
  protected readonly section = inject(SectionService);
  protected readonly repoUrl = REPO_URL;
  protected readonly brandName = computed(() => this.journal.brandName());
  protected readonly tagline = computed(() => this.journal.tagline());
  protected readonly stockTagline = computed(() => isStockTagline(this.tagline()));
  protected readonly sections = computed(() => this.journal.sections());
  protected readonly serverError = computed(() => this.journal.loadError());

  private readonly themeService = inject(ThemeService);
  protected readonly theme = this.themeService.mode;
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
    const path = routePath(this.url());
    return this.section.current() !== null && path !== '/' && !path.startsWith('/setup') && path !== '/settings';
  });

  protected readonly isCheatsheet = computed(() => routePath(this.url()).endsWith('/cheatsheet'));

  constructor() {
    const router = this.router;
    // Close mobile menu on any navigation
    router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.menuOpen.set(false));
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  protected toggleMenu(): void {
    this.menuOpen.update((v) => !v);
  }

  /** Switch to another section, keeping the same page when it exists there. */
  protected switchSection(id: string): void {
    const path = routePath(this.url());
    const rest = path.split('/').slice(2).join('/');
    // Lesson slugs are section-specific; land on the section home instead.
    const target = rest.startsWith('lesson/') ? [] : rest ? [rest] : [];
    void this.router.navigate(['/', id, ...target]);
  }

}

export function routePath(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? '/';
}
