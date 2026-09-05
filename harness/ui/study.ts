/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { UiScenario } from './context.ts';
import { join } from 'node:path';
import { repoRoot } from '../lib.ts';

export async function studyScenario({
  r,
  page,
  pageErrors,
  shot,
  goto,
  seen,
  body,
  axeViolations,
}: UiScenario): Promise<void> {
  r.section('Spanish pair');
  await goto('/es-en');
  await seen('Saludos');
  await shot('06-es-lessons');
  await goto('/es-en/lesson/fin-de-semana-preterito');
  await seen('Takeaway');
  r.rec('lesson article renders', (await page.locator('.il-lesson-article').count()) > 0);
  r.rec('glossary cards render', (await page.locator('.il-vocab-card').count()) >= 3);
  r.rec(
    'lesson page offers canonical JSON export',
    await page.getByRole('button', { name: /Export JSON/i }).isVisible(),
  );
  const lessonRail = page.locator('.il-lesson-rail');
  r.rec('lesson page has the sticky section rail', await lessonRail.isVisible());
  r.rec(
    'lesson number counts from the oldest lesson',
    /lesson 2/i.test(await page.locator('.il-lesson-num').innerText()),
  );
  r.rec(
    'lesson renders extracted slides and their tables',
    (await page.locator('.il-slide-card').count()) === 2 &&
      (await page.locator('.il-slide-table').count()) === 2,
  );
  const axeIssues = await axeViolations();
  r.rec(
    'lesson page passes the automated WCAG 2.2 AA scan',
    axeIssues.length === 0,
    axeIssues
      .map((issue) => `${issue.id} (${issue.impact}): ${issue.targets.join(', ')}`)
      .join(' | '),
  );
  const lessonCardsHref =
    (await page
      .locator('.il-lesson-actions a')
      .filter({ hasText: /Study this lesson/i })
      .getAttribute('href')) ?? '';
  r.rec(
    'lesson card action opens the whole lesson deck',
    /lesson=fin-de-semana-preterito/.test(lessonCardsHref) && !/mini=/.test(lessonCardsHref),
    lessonCardsHref,
  );
  const slidesJump = lessonRail.getByRole('link', { name: /slides/i });
  await slidesJump.click();
  await page.waitForTimeout(200);
  const slidesTop = await page
    .locator('#lesson-slides')
    .evaluate((el) => el.getBoundingClientRect().top);
  r.rec(
    'lesson rail jump links reach their section',
    page.url().endsWith('/es-en/lesson/fin-de-semana-preterito#lesson-slides') &&
      slidesTop >= 0 &&
      slidesTop < 140,
    `${page.url()} top=${Math.round(slidesTop)}`,
  );
  await shot('07-es-lesson');

  const quiz = page.locator('app-quiz');
  await quiz.waitFor({ timeout: 10_000 });
  const items = quiz.locator('ol > li');
  const n = await items.count();
  const keyboardChoice = quiz.locator('input[type=radio]').first();
  await keyboardChoice.focus();
  await page.keyboard.press('Space');
  let translations = 0;
  for (let i = 0; i < n; i++) {
    const li = items.nth(i);
    const kind = await li.getAttribute('data-quiz-type');
    if (kind === 'mc') {
      await li.locator('input[type=radio]').first().check();
    } else if (kind === 'fill') {
      await li.locator('input[type=text]').fill('x');
    } else {
      translations++;
      await li.locator('textarea').fill('hola');
    }
  }
  const check = quiz.getByRole('button', { name: 'Check', exact: true });
  await check.waitFor({ state: 'visible', timeout: 10_000 });
  r.rec(
    'quiz Check is available before translation self-grading',
    (await check.isEnabled()) && (await quiz.locator('.il-quiz-model-answer').count()) === 0,
  );
  await check.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  r.rec(
    'quiz answer and Check work from the keyboard',
    (await keyboardChoice.isChecked()) && (await quiz.locator('.il-quiz-model-answer').count()) > 0,
  );
  const pendingAfterCheck = await quiz.locator('.il-quiz-item--open').count();
  r.rec(
    'quiz Check grades objective answers and reveals every translation',
    (await quiz.locator('.il-quiz-item--right, .il-quiz-item--wrong').count()) ===
      n - pendingAfterCheck &&
      (await quiz.locator('.il-quiz-model-answer').count()) === pendingAfterCheck,
    `questions=${n} translations=${translations} pending=${pendingAfterCheck}`,
  );
  const saveScore = quiz.getByRole('button', { name: /^Save score/i });
  r.rec(
    'quiz gives the disabled Save score action a visible reason',
    translations === 0 ||
      (!(await saveScore.isEnabled()) &&
        /translation.*left to grade/i.test(await saveScore.innerText())),
  );
  for (let i = 0; i < n; i++) {
    const li = items.nth(i);
    if ((await li.getAttribute('data-quiz-type')) !== 'translate') continue;
    const closeEnough = li.getByRole('button', { name: /Close enough/i });
    if (await closeEnough.count()) await closeEnough.click();
  }
  await page.waitForTimeout(100);
  r.rec('quiz Save score enables once every translation is graded', await saveScore.isEnabled());
  await saveScore.click();
  await page.waitForTimeout(300);
  const score = (await quiz.innerText()).match(/\d+\s*\/\s*\d+/)?.[0];
  r.rec('quiz saves and shows the final score', !!score, score);
  await shot('08-es-quiz');

  const topic = page.locator('.il-topic-chip').first();
  if (await topic.count()) {
    await topic.click();
    await page.waitForTimeout(500);
    r.rec(
      'topic chip filters the lesson list',
      (await page.locator('.il-filter-bar, .il-filter-value').count()) > 0,
      page.url(),
    );
  }

  const largeVocab = Array.from({ length: 733 }, (_, index) => {
    const letter = String.fromCharCode(97 + (index % 26));
    const target =
      index === 0
        ? 'hola'
        : index === 1
          ? 'gusto'
          : `${letter} parola ${String(index + 1).padStart(3, '0')}`;
    return {
      id: `2026-09-04-lesson-one:vocab:${String(index + 1).padStart(3, '0')}`,
      source_ids: [`2026-09-04-lesson-one:vocab:${String(index + 1).padStart(3, '0')}`],
      target,
      learner: index === 0 ? 'hello' : index === 1 ? 'taste' : `word ${index + 1}`,
      level: ['A1', 'A2', 'B1', 'B2'][index % 4],
      example_target: `Esempio per ${target}.`,
      example_learner: `Example for ${target}.`,
      first_seen: 'lesson-one',
      first_seen_date: '2026-09-04',
      seen_in: index % 3 === 0 ? ['lesson-one', 'lesson-two'] : ['lesson-one'],
    };
  });
  await page.route('**/api/sections/es-en/vocab', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(largeVocab),
    });
  });
  await goto('/es-en/vocab');
  await page.locator('.il-vocab-row').first().waitFor({ timeout: 10_000 });
  r.rec(
    'large glossary uses a counted alphabet index',
    (await page.locator('.il-vocab-letter').count()) === 28 &&
      /733 words/.test(await page.locator('.il-vocab-title-row').innerText()),
  );
  r.rec(
    'large glossary keeps fifty entries per page',
    (await page.locator('.il-vocab-row').count()) === 50 &&
      /1–50 of 733/.test(await page.locator('.il-vocab-pagination').innerText()),
  );
  const letterA = page
    .locator('.il-vocab-letter:not(.il-vocab-letter--all)')
    .filter({ hasText: /^A/ })
    .first();
  await letterA.click();
  await page.waitForTimeout(100);
  const aWords = await page.locator('.il-vocab-word > span:first-child').allInnerTexts();
  r.rec(
    'letter index filters directly to that part of the glossary',
    aWords.length > 0 && aWords.every((word) => /^[aàáâä]/i.test(word)),
    `${aWords.length} A words`,
  );
  await letterA.click();
  await shot('09-es-glossary');
  await page
    .getByPlaceholder(/Search/i)
    .first()
    .fill('gusto');
  await page.waitForTimeout(300);
  r.rec(
    'glossary search narrows the list',
    /gusto/i.test(await body()) && !/^\s*$/.test(await body()),
  );

  await goto('/es-en/flashcards?lesson=fin-de-semana-preterito');
  await seen('Flashcards');
  const deckSelect = page.locator('.il-cards-deck-select select');
  await page.locator('.il-study-card').waitFor({ timeout: 10_000 });
  const selectedDeck = await deckSelect.locator('option:checked').innerText();
  const deckStats = await page.locator('.il-cards-deck-stats').innerText();
  const deckSize = Number(deckStats.match(/^\d+/)?.[0] ?? 0);
  r.rec(
    'Cards lesson filter names the active lesson and its card count',
    /This lesson.*fin de semana/i.test(selectedDeck) && deckSize > 10,
    `${selectedDeck} | ${deckStats}`,
  );
  r.rec(
    'lesson deck explains its one-pass rule',
    /start to finish.*daily limit.*All cards/i.test(
      await page.locator('.il-cards-deck-help').innerText(),
    ),
  );
  for (let i = 0; i < 10; i++) {
    await page.getByRole('button', { name: /^skip$/i }).click();
    await page.waitForFunction(
      (expected) =>
        Number(document.querySelector('.il-study-card-meta')?.textContent?.match(/\d+/)?.[0]) ===
        expected,
      i + 2,
      { timeout: 2_000 },
    );
  }
  const cardProgress = await page.locator('.il-study-card-meta').innerText();
  const cardNumbers = cardProgress.match(/\d+/g)?.map(Number) ?? [];
  r.rec(
    'lesson deck continues past the ten-card daily limit',
    cardNumbers[0] === 11 && cardNumbers[1] === deckSize,
    cardProgress,
  );
  await deckSelect.selectOption('greetings');
  await page.waitForURL(/\/es-en\/flashcards\?lesson=greetings$/);
  await page.locator('.il-study-card').waitFor({ timeout: 10_000 });
  const switchedDeckStats = await page.locator('.il-cards-deck-stats').innerText();
  const switchedDeckSize = Number(switchedDeckStats.match(/^\d+/)?.[0] ?? 0);
  const switchedSource = await page.locator('.il-study-source').innerText();
  r.rec(
    'deck selector switches to that lesson’s cards without leaving Cards',
    /This lesson.*Saludos/i.test(await deckSelect.locator('option:checked').innerText()) &&
      switchedDeckSize > 0 &&
      switchedDeckSize !== deckSize &&
      /greetings/i.test(switchedSource),
    `${page.url()} | ${switchedDeckStats} | ${switchedSource}`,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const cardsPageFits = await page
    .locator('.il-cards-page')
    .evaluate(
      (el) =>
        el.scrollWidth <= el.clientWidth &&
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
  r.rec('Cards deck controls fit a phone viewport', cardsPageFits);
  const levelRowSizes = await page
    .locator('.il-cards-filter-group--levels .il-chip')
    .evaluateAll((buttons) => {
      const rows = new Map<number, number>();
      for (const button of buttons) {
        const top = Math.round(button.getBoundingClientRect().top);
        rows.set(top, (rows.get(top) ?? 0) + 1);
      }
      return [...rows.values()];
    });
  r.rec(
    'Cards level filters wrap as a balanced group',
    levelRowSizes.join('|') === '4|3',
    levelRowSizes.join(' + '),
  );
  r.rec(
    'phone Sheet action sits in the header instead of over the cards',
    (await page.locator('.il-mobile-sheet').isVisible()) &&
      !(await page.locator('.il-fab').isVisible()),
  );
  await shot('10a-es-cards-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });

  await goto('/es-en/flashcards');
  await seen(/Cards|Flashcards/);
  const typeInput = page.getByPlaceholder(/your answer/i);
  if (await typeInput.count()) {
    await typeInput.focus();
    await page.keyboard.type('zzzz-wrong');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    r.rec('flashcards grade a typed answer from the keyboard', /Wrong|Correct:/.test(await body()));
  } else {
    r.skip(
      'flashcards grade a typed answer from the keyboard',
      'no typing input on the first card',
    );
  }
  await shot('10-es-cards');

  await goto('/es-en/search');
  await page.locator('input[type=search]').first().fill('hola');
  await page.waitForTimeout(800);
  r.rec('search finds hola', /hola/i.test(await body()) && !/Nothing for/i.test(await body()));
  await shot('11-es-search');

  const cheatFixture = {
    processed_lessons: Array.from({ length: 33 }, (_, index) => `lesson-${index + 1}`),
    updated_at: '2026-09-04T12:00:00.000Z',
    categories: [
      {
        id: 'tenses',
        title: 'Tenses',
        sections: [
          {
            id: 'present-tense',
            title: 'Present tense',
            main_table: [
              ['person', '-are'],
              ['io', 'parlo'],
              ['tu', 'parli'],
            ],
            exception_tables: [],
            notes: ['Use the present for habits and facts.'],
            source_lessons: ['greetings'],
          },
          {
            id: 'passato-prossimo',
            title: 'Passato prossimo',
            main_table: [
              ['person', 'avere + participle', 'essere + participle'],
              ['io', 'ho parlato', 'sono andato/a'],
              ['tu', 'hai parlato', 'sei andato/a'],
            ],
            exception_tables: [
              {
                title: 'Irregular participles',
                table: [
                  ['fare', 'dire'],
                  ['fatto', 'detto'],
                ],
              },
            ],
            notes: ['Movement and change of state usually take essere.'],
            source_lessons: ['fin-de-semana-preterito'],
          },
        ],
      },
      {
        id: 'verbs',
        title: 'Verbs',
        sections: [
          {
            id: 'modal-verbs',
            title: 'Modal verbs',
            main_table: [
              ['verb', 'meaning'],
              ['potere', 'can'],
            ],
            exception_tables: [],
            notes: [],
            source_lessons: ['greetings'],
          },
          {
            id: 'reflexive-verbs',
            title: 'Reflexive verbs',
            exception_tables: [],
            notes: ['The pronoun changes with the subject.'],
            source_lessons: [],
          },
        ],
      },
    ],
  };
  await page.route('**/api/sections/es-en/cheatsheet', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cheatFixture),
    });
  });
  await goto('/es-en/cheatsheet');
  await seen('Cheatsheet');
  const sheetRail = page.locator('.il-sheet-rail');
  r.rec(
    'cheat sheet has a grouped section rail',
    (await sheetRail.isVisible()) && (await sheetRail.locator('.il-sheet-rail-link').count()) === 4,
  );
  const railSearch = sheetRail.locator('input[type=search]');
  await railSearch.fill('modal');
  r.rec(
    'cheat sheet rail finds a section by name',
    (await sheetRail.locator('.il-sheet-rail-link').count()) === 1 &&
      /Modal verbs/.test(await sheetRail.innerText()),
  );
  await railSearch.fill('');
  const pastLink = sheetRail.getByRole('link', { name: 'Passato prossimo' });
  await pastLink.click();
  await page.waitForTimeout(150);
  const sheetTop = await page
    .locator('#sheet-tenses-passato-prossimo')
    .evaluate((element) => element.getBoundingClientRect().top);
  r.rec(
    'cheat sheet rail jumps to the selected section',
    page.url().endsWith('#sheet-tenses-passato-prossimo') && sheetTop >= 0 && sheetTop < 140,
    `${page.url()} top=${Math.round(sheetTop)}`,
  );
  r.rec(
    'Sheet shortcut stays off the Cheat Sheet content',
    (await page.locator('.il-fab').count()) === 0,
  );
  await shot('11b-es-cheatsheet');
  await goto('/es-en/compose');
  await seen('Add a conspect');
  const composeTabs = page.getByRole('tab');
  r.rec(
    'Add presents four explicit input tabs',
    (await composeTabs.count()) === 4,
    `n=${await composeTabs.count()}`,
  );
  const setupState = page.locator('.il-compose-setup-state');
  r.rec(
    'pipeline-not-ready state points at Local tools',
    (await setupState.isVisible()) &&
      /Recordings need hearing/.test(await setupState.innerText()) &&
      /\/es-en\/application#local-tools$/.test(
        (await setupState.getByRole('link').getAttribute('href')) ?? '',
      ),
  );
  await page
    .locator('.il-compose-dropzone input[type=file]')
    .setInputFiles(join(repoRoot, 'harness', 'fixtures', 'transcript.txt'));
  await seen('transcript.txt');
  r.rec(
    'file choice shows all five preflight stages',
    (await page.locator('.il-compose-steps li').count()) === 5,
  );
  r.rec(
    'file choice waits for Start',
    (await page.locator('.il-job').count()) === 0 &&
      /Ready\. This is what Start will do/.test(await body()),
  );
  await shot('12-es-compose');

  await page.getByRole('tab', { name: /Import a lesson/i }).click();
  const demoLessonFile = join(repoRoot, 'journal', 'es-en', '2026-01-01-greetings.json');
  await page.locator('#compose-panel-import input[type=file]').setInputFiles(demoLessonFile);
  const beforeExpectedConflict = pageErrors.length;
  await page.getByRole('button', { name: /^Import lesson$/i }).click();
  await page.getByText(/already here/i).waitFor({ timeout: 10_000 });
  r.rec(
    'lesson import stops on a clash and offers both choices',
    (await page.getByRole('button', { name: /^Keep both$/i }).isVisible()) &&
      (await page.getByRole('button', { name: /Replace existing/i }).isVisible()),
  );
  const unexpectedImportErrors = pageErrors
    .slice(beforeExpectedConflict)
    .filter((message) => !/status of 409 \(Conflict\)/i.test(message));
  pageErrors.splice(
    beforeExpectedConflict,
    pageErrors.length - beforeExpectedConflict,
    ...unexpectedImportErrors,
  );
  await page.getByRole('tab', { name: /recording/i }).click();

  const jobStart = new Date(Date.now() - 72_000).toISOString();
  const writingStart = new Date(Date.now() - 24_000).toISOString();
  const fakeStages = [
    { id: 'hearing', status: 'skipped', startedAt: jobStart, finishedAt: jobStart },
    { id: 'slides', status: 'skipped', startedAt: jobStart, finishedAt: jobStart },
    { id: 'writing', status: 'running', startedAt: writingStart },
    { id: 'checking', status: 'waiting' },
  ];
  const fakeBase = {
    id: 'harness-job',
    section: 'es-en',
    kind: 'process',
    label: 'transcript.txt',
    createdAt: jobStart,
    startedAt: jobStart,
  };
  let fakePolls = 0;
  const postRoute = '**/api/sections/es-en/uploads';
  const getRoute = '**/api/jobs/harness-job';
  await page.route(postRoute, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...fakeBase, status: 'queued', log: '', stages: fakeStages }),
    });
  });
  await page.route(getRoute, async (route) => {
    fakePolls++;
    const done = fakePolls >= 5;
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...fakeBase,
        status: done ? 'done' : 'running',
        log: done
          ? 'write  lesson valid\ncheck  schema valid\nsave   ready'
          : 'write  waiting for the model…',
        ...(done ? { finishedAt: now } : {}),
        stages: done
          ? fakeStages.map((stage) => ({
              ...stage,
              status:
                stage.status === 'running'
                  ? 'done'
                  : stage.status === 'waiting'
                    ? 'done'
                    : stage.status,
              finishedAt: stage.finishedAt ?? now,
            }))
          : fakeStages,
      }),
    });
  });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.locator('.il-job-stage--running').waitFor({ timeout: 5_000 });
  r.rec(
    'running job shows the four named stages',
    (await page.locator('.il-job-stage').count()) === 4 &&
      /Hearing.*Slides.*Writing.*Checking/s.test(await page.locator('.il-job-stages').innerText()),
  );
  r.rec(
    'running job shows elapsed time and a live log',
    /\d+:\d{2}.*elapsed/.test(await page.locator('.il-job-time').innerText()) &&
      /waiting for the model/i.test(await page.locator('.il-job .il-log').innerText()),
  );
  r.rec(
    'job progress distinguishes skipped, active and waiting stages',
    (await page.locator('.il-job-stage--skipped').count()) === 2 &&
      (await page.locator('.il-job-stage--running').count()) === 1 &&
      (await page.locator('.il-job-stage--waiting').count()) === 1,
  );
  await page.evaluate(() => {
    (window as Window & { __hornbookHidden?: boolean }).__hornbookHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  });
  await shot('12b-es-job-running');
  await page.locator('.il-job--done').waitFor({ timeout: 8_000 });
  const notificationState = await page.evaluate(() => ({
    hidden: document.hidden,
    permission: typeof Notification === 'undefined' ? 'missing' : Notification.permission,
    notifications:
      (window as Window & { __hornbookNotifications?: { title: string; body: string }[] })
        .__hornbookNotifications ?? [],
  }));
  r.rec(
    'background completion sends a browser notification',
    notificationState.notifications.some(
      (item) =>
        /Hornbook job finished/.test(item.title) && /transcript\.txt is ready/.test(item.body),
    ),
    JSON.stringify(notificationState),
  );
  r.rec(
    'finished job keeps its final log visible',
    /schema valid/.test(await page.locator('.il-job .il-log').innerText()) &&
      (await page.locator('.il-job-stage--done').count()) === 2,
  );
  await page.evaluate(() => {
    (window as Window & { __hornbookHidden?: boolean }).__hornbookHidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });
  await shot('12c-es-job-done');
  await page.unroute(postRoute);
  await page.unroute(getRoute);

  await goto('/es-en/settings');
  await seen('This pair');
  const presets = page.locator('.il-preset');
  r.rec(
    'pair settings show the theme presets',
    (await presets.count()) >= 6,
    `n=${await presets.count()}`,
  );
  r.rec(
    'pair settings offer ZIP export with optional progress',
    (await page.getByRole('button', { name: /Export pair/i }).isVisible()) &&
      (await page.getByText(/Include study progress/i).isVisible()),
  );
  await presets.nth(2).click();
  await page.waitForTimeout(300);
  await shot('13-es-pair-settings');
}
