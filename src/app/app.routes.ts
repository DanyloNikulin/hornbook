import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
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
    path: 'setup',
    loadComponent: () => import('./setup/setup.component').then((m) => m.SetupComponent),
  },
  // Wildcard last: unknown URLs get a page with a way home instead of a
  // router error over an empty <main> (issue #70).
  {
    path: '**',
    loadComponent: () => import('./not-found/not-found.component').then((m) => m.NotFoundComponent),
  },
];
