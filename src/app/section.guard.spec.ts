import { describe, expect, it } from 'vitest';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { SectionSummary } from '../lib/api-types';
import { JournalService } from './journal.service';
import { SectionService } from './section.service';
import { sectionMatch } from './section.guard';

@Component({ template: 'home' })
class HomeStubComponent {}

@Component({ template: 'pair' })
class PairStubComponent {}

@Component({ template: 'missing' })
class MissingStubComponent {}

const ES: SectionSummary = {
  id: 'es-en',
  target: 'es',
  learner: 'en',
  label: 'Spanish → English',
  flags: { target: '🇪🇸', learner: '🇬🇧' },
  lessonCount: 1,
};

/** The parts of JournalService the matcher touches. */
function journalWith(sections: SectionSummary[], loadError: string | null = null): unknown {
  return {
    ensureLoaded: async () => undefined,
    section: (id: string) => sections.find((s) => s.id === id),
    loadError: () => loadError,
  };
}

function setup(journal: unknown): void {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: '', pathMatch: 'full', component: HomeStubComponent },
        {
          path: ':section',
          canMatch: [sectionMatch],
          children: [
            { path: '', pathMatch: 'full', component: PairStubComponent },
            { path: '**', component: MissingStubComponent },
          ],
        },
        { path: '**', component: MissingStubComponent },
      ]),
      { provide: JournalService, useValue: journal },
    ],
  });
}

describe('sectionMatch', () => {
  it('matches a pair that exists', async () => {
    setup(journalWith([ES]));
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/es-en');
    expect(page).toBeInstanceOf(PairStubComponent);
    expect(TestBed.inject(Router).url).toBe('/es-en');
  });

  it('lets an unknown pair fall through to the wildcard at the same URL', async () => {
    setup(journalWith([ES]));
    TestBed.inject(SectionService).set(ES);
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/zz-zz');
    expect(page).toBeInstanceOf(MissingStubComponent);
    expect(TestBed.inject(Router).url).toBe('/zz-zz');
    expect(TestBed.inject(SectionService).current()).toBeNull();
  });

  it('goes home when the journal could not be loaded', async () => {
    setup(journalWith([], 'HTTP 503'));
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/es-en');
    expect(page).toBeInstanceOf(HomeStubComponent);
    expect(TestBed.inject(Router).url).toBe('/');
  });
});
