import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlashcardsComponent } from './flashcards.component';
import { CardsService, type Card } from '../cards.service';
import { LessonsService } from '../lessons.service';
import { SectionService } from '../section.service';

interface Board {
  selectPairLeft(card: Card): void;
  selectPairRight(card: Card): void;
  resetPairsBoard(): void;
  startPairsRound(): void;
  pairsSelectedLeft(): string | null;
  pairsWrongLeft(): string | null;
  pairsMatched(): ReadonlySet<string>;
}
const cards: Card[] = ['hola', 'adiós', 'gracias'].map((id) => ({
  id,
  front: id,
  back: id,
  direction: 'target-learner',
  source: 'vocab',
  type: 'word',
  tags: [],
  lessons: [],
}));
let board: Board;
beforeEach(async () => {
  localStorage.setItem('flashcards-mode', 'pairs');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  TestBed.configureTestingModule({
    providers: [
      { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({})) } },
      { provide: Router, useValue: {} },
      { provide: SectionService, useValue: { id: () => 'es-en' } },
      { provide: LessonsService, useValue: {} },
      {
        provide: CardsService,
        useValue: { pickPairsRound: () => cards, revision: () => 0, all: async () => cards },
      },
    ],
  });
  board = TestBed.runInInjectionContext(() => new FlashcardsComponent()) as unknown as Board;
  TestBed.tick();
  await Promise.resolve();
  TestBed.tick();
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
  localStorage.removeItem('flashcards-mode');
});

it('keeps a new selection after an earlier mismatch and lets it match', () => {
  board.selectPairLeft(cards[0]);
  board.selectPairRight(cards[1]);
  vi.advanceTimersByTime(200);
  board.selectPairLeft(cards[2]);
  vi.advanceTimersByTime(1000);
  expect(board.pairsSelectedLeft()).toBe(cards[2].id);
  expect(board.pairsWrongLeft()).toBeNull();
  board.selectPairRight(cards[2]);
  expect(board.pairsMatched().has(cards[2].id)).toBe(true);
});

it('gives a later mismatch its full feedback interval', () => {
  board.selectPairLeft(cards[0]);
  board.selectPairRight(cards[1]);
  vi.advanceTimersByTime(400);
  board.selectPairRight(cards[2]);
  vi.advanceTimersByTime(300);
  expect(board.pairsSelectedLeft()).toBe(cards[0].id);
  vi.advanceTimersByTime(300);
  expect(board.pairsSelectedLeft()).toBeNull();
});

it('cancels feedback when a round is reset or the component is destroyed', () => {
  const baseline = vi.getTimerCount();
  board.selectPairLeft(cards[0]);
  board.selectPairRight(cards[1]);
  board.resetPairsBoard();
  expect(vi.getTimerCount()).toBe(baseline);
  board.selectPairLeft(cards[1]);
  board.selectPairRight(cards[2]);
  TestBed.resetTestingModule();
  expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline);
});
