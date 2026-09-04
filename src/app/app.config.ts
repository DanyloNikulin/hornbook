import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { ViewportScroller } from '@angular/common';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

import { routes } from './app.routes';
import { JournalService } from './journal.service';
import { SectionRouteReuse } from './route-reuse';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ anchorScrolling: 'enabled', scrollPositionRestoration: 'enabled' }),
    ),
    { provide: RouteReuseStrategy, useClass: SectionRouteReuse },
    provideAppInitializer(() => inject(ViewportScroller).setOffset([0, 96])),
    // Brand and the section list are needed before the first paint.
    provideAppInitializer(() => inject(JournalService).load()),
  ],
};
