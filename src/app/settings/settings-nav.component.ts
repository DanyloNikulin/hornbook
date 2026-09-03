import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TPipe } from '../i18n.pipe';
import { SectionService } from '../section.service';

/** Pair vs application. Shown on both settings pages when a pair is current. */
@Component({
  selector: 'app-settings-nav',
  imports: [RouterLink, RouterLinkActive, TPipe],
  template: `
    <nav class="il-settings-tabs" [attr.aria-label]="'settings.tabsAria' | t">
      @if (pairLink(); as pair) {
        <a [routerLink]="pair"
           routerLinkActive="active"
           [routerLinkActiveOptions]="{ exact: true }"
           class="il-chip">{{ 'settings.tabPair' | t }}</a>
        <a [routerLink]="appInPair()"
           routerLinkActive="active"
           class="il-chip">{{ 'settings.tabApp' | t }}</a>
      } @else {
        <a routerLink="/settings"
           routerLinkActive="active"
           [routerLinkActiveOptions]="{ exact: true }"
           class="il-chip">{{ 'settings.tabApp' | t }}</a>
      }
    </nav>
  `,
})
export class SettingsNavComponent {
  private readonly section = inject(SectionService);

  protected readonly pairLink = computed(() => {
    const id = this.section.id();
    return id ? ['/', id, 'settings'] : null;
  });

  protected readonly appInPair = computed(() => ['/', this.section.id(), 'application']);
}
