import { Injectable } from '@angular/core';
import { Lesson, LessonMeta, type LessonT, type LessonMetaT, type TopicT } from '../lib/schema';
import lessonsMetaRaw from './_data/lessons-meta.json';

// How many topic-overlap candidates we surface in "See also".
// Keeps the list scannable; the AI-picked `related[]` already covers
// hand-curated picks, so this is the breadth knob, not depth.
const RELATED_BY_TOPICS_CAP = 5;

export interface RelatedByTopicsMeta {
  readonly meta: LessonMetaT;
  // Topic IDs shared with the source lesson, in vocab declaration order.
  // Length doubles as the overlap-count badge.
  readonly sharedTopics: readonly TopicT[];
}

/**
 * Two-tier lesson API after #19's lazy-load refactor:
 *
 *   • `allMeta()`, `getMetaBySlug()`, `indexBySlug()`, `neighborsMeta()`,
 *     `pickRandomMeta()`, `relatedByTopicsForMeta()` — synchronous, served
 *     from a bundled metadata manifest (~80–120 B/lesson). These cover the
 *     home page, sidebar nav, and topic-overlap suggestions without dragging
 *     full lesson content into the initial JS chunk.
 *
 *   • `bySlug(slug)` — asynchronous, fetches `/lessons/<slug>.json` on
 *     demand. Promises are cached per slug for the lifetime of the session
 *     so concurrent navigations (e.g. user mashes the next-lesson button)
 *     share one in-flight request, but we don't cache resolved values —
 *     the HTTP layer (CF Pages `Cache-Control: max-age=3600`) handles that.
 */
@Injectable({ providedIn: 'root' })
export class LessonsService {
  private readonly metas: readonly LessonMetaT[];

  // In-flight + completed fetches. Promise per slug → next caller awaits the
  // same one. Rejections are auto-evicted so resource.reload() performs a
  // fresh request after a transient network, HTTP, or parse failure.
  private readonly cache = new Map<string, Promise<LessonT>>();

  constructor() {
    // Fail-isolate: a single malformed meta must not crash the whole app.
    // Log and skip — the rest of the catalog stays usable.
    this.metas = (lessonsMetaRaw as unknown[]).flatMap((raw, idx) => {
      const result = LessonMeta.safeParse(raw);
      if (!result.success) {
        // eslint-disable-next-line no-console
        console.error(`Skipping invalid lesson meta at index ${idx}:`, result.error.format());
        return [];
      }
      return [result.data];
    });
  }

  // ── Synchronous metadata API (bundled manifest) ──────────────────────────

  allMeta(): readonly LessonMetaT[] {
    return this.metas;
  }

  getMetaBySlug(slug: string): LessonMetaT | undefined {
    return this.metas.find((m) => m.slug === slug);
  }

  indexBySlug(slug: string): number {
    return this.metas.findIndex((m) => m.slug === slug);
  }

  neighborsMeta(slug: string): { prev: LessonMetaT | null; next: LessonMetaT | null } {
    const idx = this.indexBySlug(slug);
    if (idx === -1) return { prev: null, next: null };
    return {
      prev: idx > 0 ? this.metas[idx - 1] : null,
      next: idx < this.metas.length - 1 ? this.metas[idx + 1] : null,
    };
  }

  // Pick a uniformly random meta, optionally excluding one slug so callers
  // navigating away from the current page never land on the same lesson.
  pickRandomMeta(excludeSlug?: string): LessonMetaT | null {
    const pool = excludeSlug ? this.metas.filter((m) => m.slug !== excludeSlug) : this.metas;
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Lessons matching a topic id, returned as metas (sync). Order preserved
  // from the catalog (date desc). Empty array if topic is unknown or nothing
  // matches.
  byTopicMeta(topicId: TopicT): readonly LessonMetaT[] {
    return filterMetasByTopic(this.metas, topicId);
  }

  // Suggest "related" lessons by counting shared topics with the source meta.
  // Sorted by overlap count desc, then by catalog order (date desc) for
  // stable ties. Excludes the source meta and any meta with zero overlap.
  // Capped at RELATED_BY_TOPICS_CAP.
  relatedByTopicsForMeta(current: LessonMetaT): readonly RelatedByTopicsMeta[] {
    return computeRelatedByTopicsMeta(current, this.metas, RELATED_BY_TOPICS_CAP);
  }

  // ── Asynchronous full-content API (lazy-fetched static asset) ────────────

  async bySlug(slug: string): Promise<LessonT | undefined> {
    // Short-circuit unknown slugs without an HTTP roundtrip — the manifest is
    // the source of truth for what exists, so 404-by-design is wasteful.
    const meta = this.getMetaBySlug(slug);
    if (!meta) return undefined;

    const cached = this.cache.get(slug);
    if (cached) return cached;

    const promise = this.fetchAndValidate(meta).catch((error: unknown) => {
      // Never retain a rejected promise: resource.reload() must perform a
      // fresh request after a transient HTTP/network failure.
      this.cache.delete(slug);
      throw error;
    });

    this.cache.set(slug, promise);
    return promise;
  }

  private async fetchAndValidate(meta: LessonMetaT): Promise<LessonT> {
    // Lesson files on disk are named `<date>-<slug>.json` per the commit
    // convention (lesson.id == stem). The assets glob in angular.json
    // copies them verbatim, so the fetch URL must reconstruct the stem
    // from meta — fetching by bare slug would 404 for every lesson.
    const stem = `${meta.date}-${meta.slug}`;
    const url = `lessons/${encodeURIComponent(stem)}.json`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`LessonsService.bySlug(${meta.slug}): HTTP ${res.status} fetching ${url}`);
    }
    const raw = (await res.json()) as unknown;
    const result = Lesson.safeParse(raw);
    if (!result.success) {
      throw new Error(`LessonsService.bySlug(${meta.slug}): schema validation failed`, {
        cause: result.error,
      });
    }
    return result.data;
  }
}

// Pure helpers, exported for tests. Kept outside the @Injectable so they can
// be exercised without spinning up the whole catalog from the manifest.

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
    // Preserve the candidate's topic order in the badge so the inline
    // "#a, #b, #c" reads identically regardless of which lesson is the
    // source — the user's eye is comparing across rows.
    const sharedTopics = other.topics.filter((t) => currentTopics.has(t));
    if (sharedTopics.length === 0) continue;
    scored.push({ meta: other, sharedTopics });
  }

  // Stable sort by overlap count desc — Array.prototype.sort is stable in
  // V8 / modern JS, so equal-overlap rows keep their pool-order (catalog
  // order = date desc) as the natural tie-breaker.
  scored.sort((a, b) => b.sharedTopics.length - a.sharedTopics.length);
  return scored.slice(0, cap);
}
