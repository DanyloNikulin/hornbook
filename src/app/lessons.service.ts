import { Injectable, computed, inject, signal } from '@angular/core';
import { Lesson, LessonMeta, type LessonT, type LessonMetaT, type TopicT } from '../lib/schema';
import { ApiService } from './api.service';

// How many topic-overlap candidates we surface in "See also".
const RELATED_BY_TOPICS_CAP = 5;

export interface RelatedByTopicsMeta {
  readonly meta: LessonMetaT;
  // Topic IDs shared with the source lesson, in vocab declaration order.
  readonly sharedTopics: readonly TopicT[];
}

/**
 * Lessons of the current section.
 *
 *   • `load(sectionId)` — called by the section guard; fetches the compact
 *     metadata manifest so the synchronous API below works for every page
 *     inside the section.
 *   • `allMeta()`, `getMetaBySlug()`, `indexBySlug()`, `neighborsMeta()`,
 *     `numberBySlug()`, `pickRandomMeta()`, `byTopicMeta()`,
 *     `relatedByTopicsForMeta()` — synchronous, from the manifest.
 *   • `bySlug(slug)` — asynchronous, fetches one full lesson; promises are
 *     cached per section + slug so concurrent navigations share a request.
 */
@Injectable({ providedIn: 'root' })
export class LessonsService {
  private readonly api = inject(ApiService);

  readonly sectionId = signal<string | null>(null);
  readonly metas = signal<readonly LessonMetaT[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly count = computed(() => this.metas().length);

  private readonly cache = new Map<string, Promise<LessonT>>();

  async load(sectionId: string): Promise<void> {
    this.sectionId.set(sectionId);
    this.metas.set([]);
    try {
      const raw = await this.api.get<unknown[]>(`${this.base(sectionId)}/lessons`);
      if (this.sectionId() !== sectionId) return;
      this.metas.set(
        raw.flatMap((entry, idx) => {
          const result = LessonMeta.safeParse(entry);
          if (!result.success) {
            // eslint-disable-next-line no-console
            console.error(`Skipping invalid lesson meta at index ${idx}:`, result.error.format());
            return [];
          }
          return [result.data];
        }),
      );
      this.loadError.set(null);
    } catch (err) {
      this.loadError.set((err as Error).message);
    }
  }

  /** Re-fetch the manifest after a save in the same section. */
  async reload(): Promise<void> {
    const id = this.sectionId();
    if (id) {
      this.cache.clear();
      await this.load(id);
    }
  }

  private base(sectionId: string): string {
    return `/api/sections/${encodeURIComponent(sectionId)}`;
  }

  // ── Synchronous metadata API ─────────────────────────────────────────────

  allMeta(): readonly LessonMetaT[] {
    return this.metas();
  }

  getMetaBySlug(slug: string): LessonMetaT | undefined {
    return this.metas().find((m) => m.slug === slug);
  }

  indexBySlug(slug: string): number {
    return this.metas().findIndex((m) => m.slug === slug);
  }

  /** Human lesson number, counted from the oldest lesson in a newest-first manifest. */
  numberBySlug(slug: string): number | null {
    const idx = this.indexBySlug(slug);
    return idx === -1 ? null : this.metas().length - idx;
  }

  neighborsMeta(slug: string): { prev: LessonMetaT | null; next: LessonMetaT | null } {
    const metas = this.metas();
    const idx = this.indexBySlug(slug);
    if (idx === -1) return { prev: null, next: null };
    return {
      prev: idx > 0 ? metas[idx - 1] : null,
      next: idx < metas.length - 1 ? metas[idx + 1] : null,
    };
  }

  pickRandomMeta(excludeSlug?: string): LessonMetaT | null {
    const metas = this.metas();
    const pool = excludeSlug ? metas.filter((m) => m.slug !== excludeSlug) : metas;
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  byTopicMeta(topicId: TopicT): readonly LessonMetaT[] {
    return filterMetasByTopic(this.metas(), topicId);
  }

  relatedByTopicsForMeta(current: LessonMetaT): readonly RelatedByTopicsMeta[] {
    return computeRelatedByTopicsMeta(current, this.metas(), RELATED_BY_TOPICS_CAP);
  }

  // ── Asynchronous full-content API ────────────────────────────────────────

  async bySlug(slug: string): Promise<LessonT | undefined> {
    const sectionId = this.sectionId();
    if (!sectionId) return undefined;
    // The manifest is the source of truth for what exists.
    if (!this.getMetaBySlug(slug)) return undefined;

    const key = `${sectionId}/${slug}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const promise = this.api
      .get<unknown>(`${this.base(sectionId)}/lessons/${encodeURIComponent(slug)}`)
      .then((raw) => {
        const result = Lesson.safeParse(raw);
        if (!result.success) {
          throw new Error(`LessonsService.bySlug(${slug}): schema validation failed`, { cause: result.error });
        }
        return result.data;
      })
      .catch((error: unknown) => {
        // Never retain a rejected promise: resource.reload() must retry.
        this.cache.delete(key);
        throw error;
      });
    this.cache.set(key, promise);
    return promise;
  }

  /** Create or replace a lesson in the current section and refresh the manifest. */
  async save(lesson: LessonT): Promise<LessonT> {
    const sectionId = this.sectionId();
    if (!sectionId) throw new Error('No section selected');
    const saved = await this.api.post<LessonT>(`${this.base(sectionId)}/lessons`, lesson);
    await this.reload();
    return saved;
  }
}

// Pure helpers, exported for tests.

export function filterMetasByTopic(
  metas: readonly LessonMetaT[],
  topicId: TopicT,
): readonly LessonMetaT[] {
  return metas.filter((m) => m.topics.includes(topicId));
}

export function computeRelatedByTopicsMeta(
  current: LessonMetaT,
  pool: readonly LessonMetaT[],
  cap = RELATED_BY_TOPICS_CAP,
): readonly RelatedByTopicsMeta[] {
  if (current.topics.length === 0) return [];
  const currentTopics = new Set<TopicT>(current.topics);

  const scored: RelatedByTopicsMeta[] = [];
  for (const other of pool) {
    if (other.slug === current.slug) continue;
    if (other.topics.length === 0) continue;
    const sharedTopics = other.topics.filter((t) => currentTopics.has(t));
    if (sharedTopics.length === 0) continue;
    scored.push({ meta: other, sharedTopics });
  }
  scored.sort((a, b) => b.sharedTopics.length - a.sharedTopics.length);
  return scored.slice(0, cap);
}
