import { inject } from '@angular/core';
import { Router, type CanActivateFn, type CanMatchFn } from '@angular/router';
import { JournalService } from './journal.service';
import { SectionService } from './section.service';
import { LessonsService } from './lessons.service';
import { ProgressStore } from './progress-store.service';

/**
 * Matches `/:section/...` only when the first segment is a pair in the
 * journal. An unknown id does not match this route at all, so the URL falls
 * through to the wildcard and renders "Page not found" at the address the
 * user typed, instead of bouncing home. Runs on every navigation inside a
 * pair, so it only looks the id up; the preload is sectionGuard's job.
 *
 * When the config could not be loaded there is no telling a bad id from a
 * dead server; home shows the load error, so go there.
 */
export const sectionMatch: CanMatchFn = async (_route, segments) => {
  const router = inject(Router);
  const journal = inject(JournalService);
  const section = inject(SectionService);

  const id = segments[0]?.path ?? '';
  await journal.ensureLoaded();
  if (journal.section(id)) return true;
  section.set(null);
  return journal.loadError() ? router.createUrlTree(['/']) : false;
};

/**
 * Activates `/:section/...`: resolves the section from the journal config,
 * makes it current, and preloads the lesson manifest and learner progress
 * so every page inside the section can read them synchronously.
 *
 * sectionMatch has already rejected unknown ids; the redirect below is the
 * safety net for a pair deleted between matching and activation. A server
 * that is down still lets the section render (with its own error state)
 * rather than leaving a blank router outlet.
 */
export const sectionGuard: CanActivateFn = async (route) => {
  const router = inject(Router);
  const journal = inject(JournalService);
  const section = inject(SectionService);
  const lessons = inject(LessonsService);
  const progress = inject(ProgressStore);

  const id = route.paramMap.get('section') ?? '';
  await journal.ensureLoaded();
  const found = journal.section(id);
  if (!found) {
    section.set(null);
    return router.createUrlTree(['/']);
  }
  section.set(found);
  await Promise.all([lessons.load(found.id), progress.load(found.id)]);
  return true;
};
