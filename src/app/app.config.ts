import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { ViewportScroller } from '@angular/common';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

import { routes } from './app.routes';
import { JournalService } from './journal.service';
import { SectionRouteReuse } from './route-reuse';
import { UpdateService } from './update.service';
import { I18nService } from './i18n.service';
import { ThemeService } from './theme.service';
import { AppearanceService } from './appearance.service';
import { ContainerViewportScroller } from './viewport-scroller';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ anchorScrolling: 'enabled', scrollPositionRestoration: 'enabled' }),
    ),
    { provide: RouteReuseStrategy, useClass: SectionRouteReuse },
    // The page scrolls inside .il-scroll, below the navigation, so the
    // router restores positions and reaches anchors there.
    { provide: ViewportScroller, useClass: ContainerViewportScroller },
    provideAppInitializer(() => inject(ViewportScroller).setOffset([0, 24])),
    provideAppInitializer(() => inject(I18nService).initialize()),
    provideAppInitializer(() => inject(ThemeService).initialize()),
    provideAppInitializer(() => inject(AppearanceService).initialize()),
    // Brand and the section list are needed before the first paint.
    provideAppInitializer(() => inject(JournalService).load()),
    provideAppInitializer(() => inject(UpdateService).initialize()),
  ],
};
