import { Routes } from '@angular/router';
import { sectionGuard } from './section.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./sections/sections.component').then((m) => m.SectionsComponent),
  },
  {
    path: 'setup',
    loadComponent: () => import('./setup/setup.component').then((m) => m.SetupComponent),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./settings/app-settings.component').then((m) => m.AppSettingsComponent),
  },
  {
    // Everything inside a language pair. The guard resolves the section and
    // preloads its manifest and progress before any child activates.
    path: ':section',
    canActivate: [sectionGuard],
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () => import('./lesson-list/lesson-list.component').then((m) => m.LessonListComponent),
      },
      {
        path: 'lesson/:slug',
        loadComponent: () => import('./lesson-detail/lesson-detail.component').then((m) => m.LessonDetailComponent),
      },
      {
        path: 'vocab',
        loadComponent: () => import('./vocab/vocab.component').then((m) => m.VocabComponent),
      },
      {
        path: 'flashcards',
        loadComponent: () => import('./flashcards/flashcards.component').then((m) => m.FlashcardsComponent),
      },
      {
        path: 'search',
        loadComponent: () => import('./search/search.component').then((m) => m.SearchComponent),
      },
      {
        path: 'cheatsheet',
        loadComponent: () => import('./cheatsheet/cheatsheet.component').then((m) => m.CheatsheetComponent),
      },
      {
        path: 'compose',
        loadComponent: () => import('./compose/compose.component').then((m) => m.ComposeComponent),
      },
      {
        path: 'settings',
        loadComponent: () => import('./settings/settings.component').then((m) => m.SettingsComponent),
      },
      {
        path: 'application',
        loadComponent: () =>
          import('./settings/app-settings.component').then((m) => m.AppSettingsComponent),
      },
      {
        path: '**',
        loadComponent: () => import('./not-found/not-found.component').then((m) => m.NotFoundComponent),
      },
    ],
  },
  // Wildcard last: unknown URLs get a page with a way home instead of a
  // router error over an empty <main>.
  {
    path: '**',
    loadComponent: () => import('./not-found/not-found.component').then((m) => m.NotFoundComponent),
  },
];
