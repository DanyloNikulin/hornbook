import { describe, it, expect } from 'vitest';
import { normalizeAnswer, checkTypedAnswer as checkTypedAnswerFor, deriveExpectedFromBack } from './cards.service';

// The historical cases below were written for an Italian target; article
// handling is per language, so pin it explicitly. Other languages are covered
// in the 'per-language articles' block at the end.
const checkTypedAnswer = (typed: string, expected: string) => checkTypedAnswerFor(typed, expected, 'it');

describe('normalizeAnswer', () => {
  it('lowercases', () => {
    expect(normalizeAnswer('CIAO')).toBe('ciao');
  });

  it('trims and collapses whitespace', () => {
    expect(normalizeAnswer('  ciao  amico  ')).toBe('ciao amico');
  });

  it('strips diacritics', () => {
    expect(normalizeAnswer('è')).toBe('e');
    expect(normalizeAnswer('caffè')).toBe('caffe');
    expect(normalizeAnswer('perché')).toBe('perche');
  });

  it('preserves spaces between words', () => {
    expect(normalizeAnswer('passato prossimo')).toBe('passato prossimo');
  });

  it("normalizes curly/backtick apostrophes to ASCII '", () => {
    expect(normalizeAnswer('l’amico')).toBe("l'amico"); // U+2019 right single quote
    expect(normalizeAnswer('un’amica')).toBe("un'amica");
    expect(normalizeAnswer('l‘amico')).toBe("l'amico"); // U+2018 left single quote
    expect(normalizeAnswer('l`amico')).toBe("l'amico"); // backtick
  });
});

describe('checkTypedAnswer — baseline', () => {
  it('exact match → exact', () => {
    expect(checkTypedAnswer('ciao', 'ciao')).toBe('exact');
  });

  it('whitespace diff but otherwise identical → exact (after trim)', () => {
    expect(checkTypedAnswer(' ciao ', 'ciao')).toBe('exact');
  });

  it('case differs → close', () => {
    expect(checkTypedAnswer('Ciao', 'ciao')).toBe('close');
  });

  it('missing diacritic → close', () => {
    expect(checkTypedAnswer('caffe', 'caffè')).toBe('close');
  });

  it('curly apostrophe in typed matches straight in expected (and vice versa)', () => {
    expect(checkTypedAnswer('l’amico', "l'amico")).toBe('close');
    expect(checkTypedAnswer("l'amico", 'l’amico')).toBe('close');
    expect(checkTypedAnswer('un’amica', "un'amica")).toBe('close');
  });

  it('completely wrong → wrong', () => {
    expect(checkTypedAnswer('addio', 'ciao')).toBe('wrong');
  });

  it('empty input → wrong', () => {
    expect(checkTypedAnswer('', 'ciao')).toBe('wrong');
    expect(checkTypedAnswer('   ', 'ciao')).toBe('wrong');
  });
});

describe('checkTypedAnswer — Italian articles (forgive missing/extra)', () => {
  it('expected has definite article, user drops it → exact', () => {
    expect(checkTypedAnswer('ragazza', 'la ragazza')).toBe('exact');
    expect(checkTypedAnswer('ragazzo', 'il ragazzo')).toBe('exact');
    expect(checkTypedAnswer('zaino', 'lo zaino')).toBe('exact');
    expect(checkTypedAnswer('ragazzi', 'i ragazzi')).toBe('exact');
    expect(checkTypedAnswer('zaini', 'gli zaini')).toBe('exact');
    expect(checkTypedAnswer('persone', 'le persone')).toBe('exact');
  });

  it('expected has indefinite article, user drops it → exact', () => {
    expect(checkTypedAnswer('ragazzo', 'un ragazzo')).toBe('exact');
    expect(checkTypedAnswer('studente', 'uno studente')).toBe('exact');
    expect(checkTypedAnswer('casa', 'una casa')).toBe('exact');
  });

  it("expected has apostrophe article (l'/un'), user drops it → exact", () => {
    expect(checkTypedAnswer('amico', "l'amico")).toBe('exact');
    expect(checkTypedAnswer('amica', "un'amica")).toBe('exact');
    expect(checkTypedAnswer('auto', "l'auto")).toBe('exact');
  });

  it('expected has no article, user adds one → exact', () => {
    expect(checkTypedAnswer('la casa', 'casa')).toBe('exact');
    expect(checkTypedAnswer('il problema', 'problema')).toBe('exact');
    expect(checkTypedAnswer("l'amico", 'amico')).toBe('exact');
  });

  it('both sides have matching article → exact', () => {
    expect(checkTypedAnswer('la ragazza', 'la ragazza')).toBe('exact');
  });

  it('article-only entry stays intact', () => {
    expect(checkTypedAnswer('il', 'il')).toBe('exact');
    expect(checkTypedAnswer('la', 'la')).toBe('exact');
  });

  it('article + case difference → close', () => {
    expect(checkTypedAnswer('Ragazza', 'la ragazza')).toBe('close');
  });
});

describe('checkTypedAnswer — Italian articles (flag wrong article)', () => {
  it('wrong gender (il vs la) → close', () => {
    expect(checkTypedAnswer('il casa', 'la casa')).toBe('close');
    expect(checkTypedAnswer('la problema', 'il problema')).toBe('close');
  });

  it('wrong masculine form (lo vs il) → close', () => {
    expect(checkTypedAnswer('lo ragazzo', 'il ragazzo')).toBe('close');
  });

  it('wrong indefinite form (un vs uno, una vs un\') → close', () => {
    expect(checkTypedAnswer('un studente', 'uno studente')).toBe('close');
    expect(checkTypedAnswer('una amica', "un'amica")).toBe('close');
  });

  it('wrong plural article → close', () => {
    expect(checkTypedAnswer('gli libri', 'i libri')).toBe('close');
    expect(checkTypedAnswer('i ragazze', 'le ragazze')).toBe('close');
  });

  it('definite vs indefinite → close', () => {
    expect(checkTypedAnswer('un ragazzo', 'il ragazzo')).toBe('close');
  });

  it('wrong article on multi-meaning entry → close', () => {
    expect(checkTypedAnswer('lo casa', 'la casa, abitazione')).toBe('close');
  });
});

describe('checkTypedAnswer — multi-meaning translations', () => {
  it('comma-separated meanings, user types one → exact', () => {
    expect(checkTypedAnswer('вокзал', 'вокзал, станція')).toBe('exact');
    expect(checkTypedAnswer('станція', 'вокзал, станція')).toBe('exact');
    expect(checkTypedAnswer('говорити', 'говорити, розмовляти')).toBe('exact');
    expect(checkTypedAnswer('розмовляти', 'говорити, розмовляти')).toBe('exact');
  });

  it('comma-separated meanings, user types the full list → exact', () => {
    expect(checkTypedAnswer('вокзал, станція', 'вокзал, станція')).toBe('exact');
  });

  it('semicolon also works as separator', () => {
    expect(checkTypedAnswer('казати', 'казати; говорити')).toBe('exact');
  });

  it('parenthetical hint is ignored', () => {
    expect(checkTypedAnswer('проблема', 'проблема (чоловічий рід!)')).toBe('exact');
    expect(checkTypedAnswer('фото', 'фото (скор. від fotografia)')).toBe('exact');
  });

  it('multi-meaning + case difference → close', () => {
    expect(checkTypedAnswer('Вокзал', 'вокзал, станція')).toBe('close');
  });

  it('wrong meaning not in the list → wrong', () => {
    expect(checkTypedAnswer('літак', 'вокзал, станція')).toBe('wrong');
  });
});

describe('checkTypedAnswer — gender/number slash variants', () => {
  it('single-vowel suffix replaces stem vowel (bello/a → bello, bella)', () => {
    expect(checkTypedAnswer('bello', 'bello/a')).toBe('exact');
    expect(checkTypedAnswer('bella', 'bello/a')).toBe('exact');
    expect(checkTypedAnswer('bello/a', 'bello/a')).toBe('exact');
  });

  it('chained Italian vowel suffixes (questo/a/i/e)', () => {
    expect(checkTypedAnswer('questo', 'questo/a/i/e')).toBe('exact');
    expect(checkTypedAnswer('questa', 'questo/a/i/e')).toBe('exact');
    expect(checkTypedAnswer('questi', 'questo/a/i/e')).toBe('exact');
    expect(checkTypedAnswer('queste', 'questo/a/i/e')).toBe('exact');
  });

  it('participle gender variant (andato/a)', () => {
    expect(checkTypedAnswer('andato', 'andato/a')).toBe('exact');
    expect(checkTypedAnswer('andata', 'andato/a')).toBe('exact');
    expect(checkTypedAnswer('io sono andato', 'io sono andato/a')).toBe('exact');
    expect(checkTypedAnswer('io sono andata', 'io sono andato/a')).toBe('exact');
  });

  it('non-vowel suffix treated as full alternative (lui/lei)', () => {
    expect(checkTypedAnswer('lui', 'lui/lei')).toBe('exact');
    expect(checkTypedAnswer('lei', 'lui/lei')).toBe('exact');
  });

  it('space-slash-space separator (questo / questa / questi / queste)', () => {
    expect(checkTypedAnswer('questo', 'questo / questa / questi / queste')).toBe('exact');
    expect(checkTypedAnswer('questa', 'questo / questa / questi / queste')).toBe('exact');
    expect(checkTypedAnswer('queste', 'questo / questa / questi / queste')).toBe('exact');
  });

  it('Ukrainian gender slash, single variant (щасливий/а)', () => {
    expect(checkTypedAnswer('щасливий', 'щасливий/а')).toBe('exact');
    expect(checkTypedAnswer('щаслива', 'щасливий/а')).toBe('exact');
  });

  it('Ukrainian gender slash, chained (гарний/а/е/і)', () => {
    expect(checkTypedAnswer('гарний', 'гарний/а/е/і')).toBe('exact');
    expect(checkTypedAnswer('гарна', 'гарний/а/е/і')).toBe('exact');
    expect(checkTypedAnswer('гарне', 'гарний/а/е/і')).toBe('exact');
    expect(checkTypedAnswer('гарні', 'гарний/а/е/і')).toBe('exact');
  });

  it('slash + case difference → close', () => {
    expect(checkTypedAnswer('Bella', 'bello/a')).toBe('close');
  });
});

describe('deriveExpectedFromBack', () => {
  it('returns the input unchanged when no separators present', () => {
    expect(deriveExpectedFromBack('hello world')).toBe('hello world');
  });

  it('splits on em-dash with surrounding spaces', () => {
    expect(deriveExpectedFromBack('цей / ця / ці — для близьких предметів')).toBe(
      'цей / ця / ці',
    );
  });

  it('splits on en-dash with surrounding spaces', () => {
    expect(deriveExpectedFromBack('answer – explanation')).toBe('answer');
  });

  it('does not split on bare hyphens inside words', () => {
    expect(deriveExpectedFromBack('passato-prossimo era stato')).toBe(
      'passato-prossimo era stato',
    );
  });

  it('splits on newline', () => {
    expect(deriveExpectedFromBack('answer\nexample sentence')).toBe('answer');
  });

  it('splits on whichever separator comes first', () => {
    expect(deriveExpectedFromBack('answer — explanation\nexample')).toBe('answer');
    expect(deriveExpectedFromBack('answer\nexample — note')).toBe('answer');
  });

  it('strips markdown bold/italic asterisks', () => {
    expect(
      deriveExpectedFromBack('tu gioc**h**i, noi gioc**h**iamo — h зберігає твердий звук'),
    ).toBe('tu giochi, noi giochiamo');
    expect(deriveExpectedFromBack('*emphasis* word')).toBe('emphasis word');
  });

  it('collapses internal whitespace', () => {
    expect(deriveExpectedFromBack('  answer   here  — note')).toBe('answer here');
  });

  it('preserves slash alternatives when no explanation follows', () => {
    expect(deriveExpectedFromBack("Io sono di Ucraina. / Io vengo dall'Ucraina.")).toBe(
      "Io sono di Ucraina. / Io vengo dall'Ucraina.",
    );
  });
});

describe('AI flashcard backs — derived + typing checked together', () => {
  it('slash alternatives in derived expected match any single variant', () => {
    const back = 'цей / ця / ці — для близьких предметів';
    const expected = deriveExpectedFromBack(back);
    expect(checkTypedAnswer('цей', expected)).toBe('exact');
    expect(checkTypedAnswer('ця', expected)).toBe('exact');
    expect(checkTypedAnswer('ці', expected)).toBe('exact');
    expect(checkTypedAnswer('цей / ця / ці', expected)).toBe('exact');
  });

  it('markdown-bolded answer matches the plain typed form', () => {
    const back = 'tu gioc**h**i, noi gioc**h**iamo — h зберігає твердий звук [k]/[g]';
    const expected = deriveExpectedFromBack(back);
    expect(checkTypedAnswer('tu giochi, noi giochiamo', expected)).toBe('exact');
    expect(checkTypedAnswer('tu giochi', expected)).toBe('exact'); // multi-meaning split
  });

  it('multi-line back: user only needs to type the answer line', () => {
    const back = 'мені подобається / мені не подобається\nMi piace la musica.';
    const expected = deriveExpectedFromBack(back);
    expect(checkTypedAnswer('мені подобається', expected)).toBe('exact');
    expect(checkTypedAnswer('мені не подобається', expected)).toBe('exact');
  });
});

describe('checkTypedAnswer — combinations', () => {
  it('article-stripped multi-meaning entry', () => {
    expect(checkTypedAnswer('treno', 'il treno, il vagone')).toBe('exact');
    expect(checkTypedAnswer('vagone', 'il treno, il vagone')).toBe('exact');
  });

  it('typed verbatim matches the stored form with slash', () => {
    expect(checkTypedAnswer('bello/a', 'bello/a')).toBe('exact');
  });

  it('typed adds article matching another meaning\'s article → exact', () => {
    // expected has two meanings with different articles; user adds an article
    // that matches one of them, even though the bare word is shared semantics.
    expect(checkTypedAnswer('il vagone', 'il treno, il vagone')).toBe('exact');
  });
});

describe('checkTypedAnswer — per-language articles', () => {
  it('Spanish: forgives a dropped article, flags a wrong one', () => {
    expect(checkTypedAnswerFor('casa', 'la casa', 'es')).toBe('exact');
    expect(checkTypedAnswerFor('el casa', 'la casa', 'es')).toBe('close');
    expect(checkTypedAnswerFor('unos libros', 'libros', 'es')).toBe('exact');
  });

  it('French: elided article is handled', () => {
    expect(checkTypedAnswerFor('ami', "l'ami", 'fr')).toBe('exact');
    expect(checkTypedAnswerFor('le ami', "l'ami", 'fr')).toBe('close');
  });

  it('German: case forms are distinct articles', () => {
    expect(checkTypedAnswerFor('Haus', 'das Haus', 'de')).toBe('exact');
    expect(checkTypedAnswerFor('der Haus', 'das Haus', 'de')).toBe('close');
  });

  it('a language without an article table never strips anything', () => {
    expect(checkTypedAnswerFor('ragazza', 'la ragazza', 'ja')).toBe('wrong');
    expect(checkTypedAnswerFor('ragazza', 'la ragazza')).toBe('wrong');
  });

  it('Italian articles are not applied to a Spanish target', () => {
    expect(checkTypedAnswerFor('zaino', 'lo zaino', 'es')).toBe('wrong');
  });
});
