import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { JournalService } from './journal.service';
import { SectionRouteReuse } from './route-reuse';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: RouteReuseStrategy, useClass: SectionRouteReuse },
    // Brand and the section list are needed before the first paint.
    provideAppInitializer(() => inject(JournalService).load()),
  ],
};
