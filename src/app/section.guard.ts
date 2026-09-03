import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { JournalService } from './journal.service';
import { SectionService } from './section.service';
import { LessonsService } from './lessons.service';
import { ProgressStore } from './progress-store.service';

/**
 * Activates `/:section/...`: resolves the section from the journal config,
 * makes it current, and preloads the lesson manifest and learner progress
 * so every page inside the section can read them synchronously.
 *
 * Unknown ids go home. A server that is down still lets the section render
 * (with its own error state) rather than leaving a blank router outlet.
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
