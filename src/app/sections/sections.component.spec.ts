import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { describe, expect, it } from 'vitest';
import { JournalService } from '../journal.service';
import { SectionService } from '../section.service';
import { SectionsComponent } from './sections.component';

@Component({ template: 'Pair lessons' })
class PairPageComponent {}

describe('SectionsComponent', () => {
  it('lets a single-pair journal return home and choose or create a pair', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: SectionsComponent },
          { path: 'es-en', component: PairPageComponent },
        ]),
      ],
    });
    const journal = TestBed.inject(JournalService);
    const section = TestBed.inject(SectionService);
    const pair = {
      id: 'es-en',
      target: 'es',
      learner: 'en',
      label: 'Spanish → English',
      flags: { target: '🇪🇸', learner: '🇬🇧' },
      lessonCount: 1,
    };
    journal.config.update((config) => ({ ...config, sections: [pair] }));
    journal.loaded.set(true);
    section.set(pair);
    const harness = await RouterTestingHarness.create('/es-en');

    await harness.navigateByUrl('/', SectionsComponent);
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/');
    expect(section.current()).toBeNull();
    const links = Array.from(harness.routeNativeElement!.querySelectorAll('a'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/es-en', '/setup']);

    links[0].click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/es-en');
  });
});
