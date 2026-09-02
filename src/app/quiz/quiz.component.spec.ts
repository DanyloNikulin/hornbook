import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuizResultsService } from '../quiz-results.service';
import { QuizComponent } from './quiz.component';
import type { QuizQuestionT } from '../../lib/schema';

// Grading is exercised through the component's protected API rather than the
// DOM: these are pure decisions and the DOM path is covered below.
interface GradingApi {
  setAnswer(i: number, value: string | number): void;
  isCorrect(q: QuizQuestionT, i: number): boolean;
}

function mount(questions: QuizQuestionT[]): GradingApi {
  const fixture = TestBed.createComponent(QuizComponent);
  fixture.componentRef.setInput('questions', questions);
  fixture.componentRef.setInput('lessonSlug', 'test');
  fixture.detectChanges();
  return fixture.componentInstance as unknown as GradingApi;
}

const FILL: QuizQuestionT = {
  type: 'fill',
  q: 'Io ___ italiano.',
  answer: 'parlo',
  alternatives: ['sto parlando'],
  case_sensitive: false,
};

describe('QuizComponent — fill / mc grading', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [QuizComponent],
      providers: [{ provide: QuizResultsService, useValue: { forLesson: () => null, record: vi.fn() } }],
    }).compileComponents();
  });

  it('fill: forgives case, outer/inner whitespace and trailing punctuation', () => {
    const c = mount([FILL]);
    for (const typed of ['parlo', '  Parlo ', 'PARLO.', 'parlo!']) {
      c.setAnswer(0, typed);
      expect(c.isCorrect(FILL, 0), typed).toBe(true);
    }
  });

  it('fill: forgives accents and apostrophe variants', () => {
    const q: QuizQuestionT = { ...FILL, answer: "c'è", alternatives: [] };
    const c = mount([q]);
    c.setAnswer(0, 'c’e');
    expect(c.isCorrect(q, 0)).toBe(true);
  });

  it('fill: accepts any listed alternative (with its own spacing)', () => {
    const c = mount([FILL]);
    c.setAnswer(0, 'sto   parlando');
    expect(c.isCorrect(FILL, 0)).toBe(true);
  });

  it('fill: rejects a wrong or empty answer', () => {
    const c = mount([FILL]);
    c.setAnswer(0, 'parli');
    expect(c.isCorrect(FILL, 0)).toBe(false);
    c.setAnswer(0, '');
    expect(c.isCorrect(FILL, 0)).toBe(false);
  });

  it('fill: case_sensitive keeps case and accents but still normalises whitespace', () => {
    const q: QuizQuestionT = { ...FILL, answer: 'È', alternatives: [], case_sensitive: true };
    const c = mount([q]);
    c.setAnswer(0, '  È  ');
    expect(c.isCorrect(q, 0)).toBe(true);
    c.setAnswer(0, 'è');
    expect(c.isCorrect(q, 0)).toBe(false);
    c.setAnswer(0, 'E');
    expect(c.isCorrect(q, 0)).toBe(false);
  });

  it('mc: only the exact answer index counts', () => {
    const q: QuizQuestionT = { type: 'mc', q: 'Articolo di "casa"?', options: ['il', 'la', 'lo'], answer: 1 };
    const c = mount([q]);
    c.setAnswer(0, 1);
    expect(c.isCorrect(q, 0)).toBe(true);
    c.setAnswer(0, 0);
    expect(c.isCorrect(q, 0)).toBe(false);
    c.setAnswer(0, '1');
    expect(c.isCorrect(q, 0)).toBe(false);
  });
});

describe('QuizComponent — translation self-grading', () => {
  const record = vi.fn();

  beforeEach(async () => {
    record.mockReset();
    await TestBed.configureTestingModule({
      imports: [QuizComponent],
      providers: [
        {
          provide: QuizResultsService,
          useValue: { forLesson: () => null, record },
        },
      ],
    }).compileComponents();
  });

  it('requires a self-grade when auto_check is false, even for a model-answer match', async () => {
    const question: QuizQuestionT = {
      type: 'translate',
      q: 'Я йду додому.',
      answer_target: 'Vado a casa.',
      alternatives: [],
      auto_check: false,
    };
    const fixture = TestBed.createComponent(QuizComponent);
    fixture.componentRef.setInput('questions', [question]);
    fixture.componentRef.setInput('lessonSlug', 'andare');
    fixture.detectChanges();

    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Vado a casa.';
    textarea.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();

    const reveal = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button: HTMLButtonElement) => button.textContent?.includes('Show model answer'),
    ) as HTMLButtonElement;
    reveal.click();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Close enough');
    expect(text).not.toContain('counted automatically');

    const submit = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button: HTMLButtonElement) => button.textContent?.includes('Check'),
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const selfGrade = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button: HTMLButtonElement) => button.textContent?.includes('Close enough'),
    ) as HTMLButtonElement;
    selfGrade.click();
    fixture.detectChanges();
    expect(submit.disabled).toBe(false);

    textarea.value = 'Sono a casa.';
    textarea.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(submit.disabled).toBe(true);

    selfGrade.click();
    fixture.detectChanges();
    expect(submit.disabled).toBe(false);

    submit.click();
    fixture.detectChanges();
    expect(record).toHaveBeenCalledWith('andare', 1, 1);
  });
});
