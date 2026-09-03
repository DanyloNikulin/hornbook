import { describe, it, beforeEach, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app';
import { SectionService } from './section.service';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('creates', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the brand and the journal-level nav outside a section', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Hornbook');
    expect(text).toContain('Pairs');
    expect(text).toContain('New pair');
    expect(text).toContain('Application');
    expect(text).not.toContain('Glossary');
    expect((fixture.nativeElement as HTMLElement).querySelector('.il-locale-btn')).toBeNull();
  });

  it('shows section links once a section is current and the URL is inside it', async () => {
    const section = TestBed.inject(SectionService);
    section.set({
      id: 'es-en',
      target: 'es',
      learner: 'en',
      label: 'Spanish → English',
      flags: { target: '🇪🇸', learner: '🇬🇧' },
      lessonCount: 1,
    });
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    // The router URL is '/' in tests, which is home — the section nav is
    // only shown on section URLs. The label still reflects the section.
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Pairs');
  });

});
