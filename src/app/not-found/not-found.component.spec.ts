import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { SectionSummary } from '../../lib/api-types';
import { NotFoundComponent } from './not-found.component';
import { SectionService } from '../section.service';

const ES: SectionSummary = {
  id: 'es-en',
  target: 'es',
  learner: 'en',
  label: 'Spanish → English',
  flags: { target: '🇪🇸', learner: '🇬🇧' },
  lessonCount: 1,
};

/** Renders the page (inside `section` when given) and returns its link targets. */
async function linkTargets(section?: SectionSummary): Promise<string[]> {
  await TestBed.configureTestingModule({
    imports: [NotFoundComponent],
    providers: [provideRouter([])],
  }).compileComponents();
  if (section) TestBed.inject(SectionService).set(section);
  const fixture = TestBed.createComponent(NotFoundComponent);
  fixture.detectChanges();
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a')).map(
    (a) => a.getAttribute('href') ?? '',
  );
}

describe('NotFoundComponent', () => {
  it('links to the current pair’s search inside a pair', async () => {
    expect(await linkTargets(ES)).toEqual(['/', '/es-en/search']);
  });

  it('offers only home outside a pair', async () => {
    expect(await linkTargets()).toEqual(['/']);
  });
});
