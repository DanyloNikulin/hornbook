import { existsSync, readFileSync } from 'node:fs';
import type { LessonT, TopicT } from '../../src/lib/schema.ts';
import type { JournalRepository } from './journal.ts';
import { sectionWriteChanges } from './section-write.ts';
import { detectTopics } from './topics.ts';
import { computeTopicsHash } from './topics-hash.ts';

export interface BackfillOptions {
  auto?: boolean;
  onlyEmpty?: boolean;
  rebuild?: boolean;
  dryRun?: boolean;
}

function storedHash(path: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && 'hash' in value && typeof value.hash === 'string'
      ? value.hash
      : null;
  } catch {
    return null;
  }
}

/** Read one section snapshot and commit lesson changes, projections and tagger version together. */
export function backfillSection(
  journal: JournalRepository,
  id: string,
  options: BackfillOptions = {},
) {
  const plan = () => {
    const section = journal.getSection(id);
    const catalog = journal.readTopicCatalog(id);
    const versionPath = journal.sectionPath(id, '_topics-version.json');
    const hash = options.auto ? computeTopicsHash(catalog) : null;
    const previousHash = existsSync(versionPath) ? storedHash(versionPath) : null;
    const hashChanged = hash !== null && hash !== previousHash;
    const onlyEmpty = options.onlyEmpty || (options.auto && !hashChanged);
    const updates: { slug: string; previous: TopicT[]; topics: TopicT[] }[] = [];
    let unchanged = 0;
    let skipped = 0;
    const changed: LessonT[] = [];
    const lessons = journal.readSectionLessons(id).map(({ lesson }) => {
      if (onlyEmpty && lesson.topics.length > 0) {
        skipped++;
        return lesson;
      }
      const text = [
        lesson.title,
        lesson.summary,
        lesson.article_md,
        ...lesson.grammar.map((grammar) => grammar.rule),
        ...lesson.grammar.flatMap((grammar) => grammar.examples),
        ...lesson.slides.map((slide) => slide.text_md),
      ].join('\n');
      const detected = detectTopics(text, catalog);
      const topics =
        options.rebuild || lesson.topics.length === 0
          ? detected
          : [...lesson.topics, ...detected.filter((topic) => !lesson.topics.includes(topic))];
      if (
        topics.length === lesson.topics.length &&
        topics.every((topic, i) => topic === lesson.topics[i])
      ) {
        unchanged++;
        return lesson;
      }
      updates.push({ slug: lesson.slug, previous: lesson.topics, topics });
      const next = { ...lesson, topics };
      changed.push(next);
      return next;
    });
    const changes = changed.length ? sectionWriteChanges(section, lessons, changed) : [];
    if (hashChanged)
      changes.push({
        path: `${id}/_topics-version.json`,
        data: JSON.stringify({ hash, updated_at: new Date().toISOString() }, null, 2) + '\n',
      });
    return {
      changes,
      result: {
        total: lessons.length,
        updates,
        unchanged,
        skipped,
        hash,
        previousHash,
        hashChanged,
      },
    };
  };
  return options.dryRun ? plan().result : journal.commit(plan);
}
