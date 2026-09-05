import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TPipe } from '../i18n.pipe';
import { QuizResultsService } from '../quiz-results.service';
import { normalizeAnswer } from '../../lib/answer-grading';
import type { QuizQuestionT } from '../../lib/schema';

type AnswerMap = Record<number, string | number | undefined>;
type SelfGradeMap = Record<number, 'right' | 'wrong' | undefined>;

@Component({
  selector: 'app-quiz',
  imports: [FormsModule, TPipe],
  templateUrl: './quiz.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuizComponent {
  private readonly results = inject(QuizResultsService);

  readonly questions = input.required<readonly QuizQuestionT[]>();
  readonly lessonSlug = input.required<string>();

  protected readonly answers = signal<AnswerMap>({});
  protected readonly selfGrades = signal<SelfGradeMap>({});
  protected readonly checked = signal(false);
  protected readonly submitted = signal(false);

  protected readonly previousBest = computed(() => this.results.forLesson(this.lessonSlug()));

  protected readonly score = computed(() => {
    if (!this.checked()) return 0;
    let s = 0;
    this.questions().forEach((q, i) => {
      if (this.isCorrect(q, i)) s += 1;
    });
    return s;
  });

  protected readonly gradedCount = computed(() => {
    if (!this.checked()) return 0;
    return this.questions().filter((q, i) => this.isGraded(q, i)).length;
  });

  protected readonly pendingTranslations = computed(() => {
    if (!this.checked()) return 0;
    return this.questions().filter((q, i) => q.type === 'translate' && !this.isGraded(q, i)).length;
  });

  protected readonly progressPercent = computed(() => {
    const total = this.questions().length;
    return total === 0 ? 0 : Math.round((this.gradedCount() / total) * 100);
  });

  protected readonly canSubmit = computed(
    () => this.checked() && this.pendingTranslations() === 0,
  );

  protected setAnswer(i: number, value: string | number): void {
    if (this.checked()) return;
    this.answers.update((m) => ({ ...m, [i]: value }));
  }

  protected check(): void {
    this.checked.set(true);
  }

  protected selfGrade(i: number, grade: 'right' | 'wrong'): void {
    if (!this.checked() || this.submitted()) return;
    this.selfGrades.update((m) => ({ ...m, [i]: grade }));
  }

  protected isGraded(q: QuizQuestionT, i: number): boolean {
    if (!this.checked()) return false;
    return q.type !== 'translate' || this.translateAutoCorrect(q, i) || this.selfGrades()[i] !== undefined;
  }

  protected isCorrect(q: QuizQuestionT, i: number): boolean {
    const ans = this.answers()[i];
    if (q.type === 'mc') {
      return typeof ans === 'number' && ans === q.answer;
    }
    if (q.type === 'fill') {
      if (typeof ans !== 'string') return false;
      // Forgive accents, apostrophe variants, punctuation, internal/outer
      // whitespace — same leniency the flashcard typing checker uses, so the
      // quiz isn't stricter than the rest of the app. `case_sensitive` keeps
      // case + accents but still normalizes whitespace.
      const norm = (s: string) =>
        q.case_sensitive ? s.trim().replace(/\s+/g, ' ') : normalizeSentence(s);
      const valid = [q.answer, ...(q.alternatives ?? [])].map(norm);
      return valid.includes(norm(ans));
    }
    // translate — auto-accept a forgiving match against the model answer or an
    // alternative; otherwise fall back to the user's manual self-grade.
    return this.translateAutoCorrect(q, i) || this.selfGrades()[i] === 'right';
  }

  // True when a translate answer forgiving-matches the model answer or any
  // alternative (same normalization as fill). Lets exact-ish translations skip
  // the manual self-grade step; creative valid rewordings still self-grade.
  protected translateAutoCorrect(q: QuizQuestionT, i: number): boolean {
    if (q.type !== 'translate' || !q.auto_check) return false;
    const ans = this.answers()[i];
    if (typeof ans !== 'string' || !ans.trim()) return false;
    const valid = [q.answer_target, ...(q.alternatives ?? [])].map(normalizeSentence);
    return valid.includes(normalizeSentence(ans));
  }

  protected submit(): void {
    if (!this.canSubmit()) return;
    this.submitted.set(true);
    this.results.record(this.lessonSlug(), this.score(), this.questions().length);
  }

  protected retry(): void {
    this.answers.set({});
    this.selfGrades.set({});
    this.checked.set(false);
    this.submitted.set(false);
  }

  // Template helpers
  protected mcChosenWrong(i: number, idx: number, q: QuizQuestionT): boolean {
    return q.type === 'mc' && this.checked() && this.answers()[i] === idx && q.answer !== idx;
  }

  protected mcCorrect(_i: number, idx: number, q: QuizQuestionT): boolean {
    return q.type === 'mc' && this.checked() && q.answer === idx;
  }
}

// Sentence-level normalization on top of the shared flashcard normalizer:
// also drops sentence punctuation (period, comma, ?, !, quotes, brackets…) so
// a typed "…regola" matches a model answer "…regola." Apostrophes are NOT
// stripped — they're meaningful in many targets (Italian l', c'è; French l'). Punctuation is
// replaced with a space (not removed) so "sì,certo" still splits into words,
// then normalizeAnswer collapses the whitespace.
const SENTENCE_PUNCT = /[.,;:!?¿¡…"«»“”()[\]{}]/g;
function normalizeSentence(s: string): string {
  return normalizeAnswer(s.replace(SENTENCE_PUNCT, ' '));
}
