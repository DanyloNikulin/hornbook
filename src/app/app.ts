import { Component, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs/operators';
import { REPO_URL } from './constants';
import { JournalService } from './journal.service';

type Theme = 'night' | 'day';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app.html',
})
export class AppComponent {
  private readonly journal = inject(JournalService);
  protected readonly repoUrl = REPO_URL;
  protected readonly brandName = this.journal.brandName();
  protected readonly tagline = this.journal.tagline();

  protected readonly theme = signal<Theme>(this.savedTheme());
  protected readonly menuOpen = signal(false);

  constructor(protected readonly router: Router) {
    effect(() => {
      const t = this.theme();
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('lj-theme', t);
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

  protected get isCheatsheet(): boolean {
    return this.router.url === '/cheatsheet';
  }

  private savedTheme(): Theme {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem('lj-theme') : null;
    if (s === 'night' || s === 'day') return s;
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'night'
      : 'day';
  }
}
