// Local aggregator: computes vocab health stats from lessons/*.json and the
// accumulated _topics-suggestions.json. The output is a small (~2-5 KB) JSON
// blob designed to be sent to Claude as the only input to the monthly vocab
// review — we never send the actual lesson content, so the AI call stays
// constant-context regardless of how big the corpus grows.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Lesson, TOPIC_VOCAB, type TopicT } from '../../src/lib/schema.ts';

export interface TopicUsage {
  topic: TopicT;
  count: number; // lessons that include this topic
  density: number; // count / total_lessons (0..1)
  first_used: string | null; // ISO date
  last_used: string | null;
  // Top co-occurring topics (by joint count, descending). Capped to keep
  // payload small.
  co_occurrence: { topic: TopicT; count: number }[];
}

export interface AccumulatedSuggestion {
  topic: string;
  count: number;
  first_seen: string;
  last_seen: string;
  sample_lessons: string[]; // capped to 3 for payload size
}

export interface VocabStats {
  total_lessons: number;
  total_topicless: number; // lessons with empty topics[]
  avg_topics_per_lesson: number;
  vocab_size: number;
  topic_usage: TopicUsage[]; // sorted by count desc
  unused_topics: TopicT[]; // count === 0
  overused_topics: TopicT[]; // density > 0.8 — likely too broad to filter on
  accumulated_suggestions: AccumulatedSuggestion[]; // sorted by count desc
  computed_at: string; // ISO timestamp
}

const OVERUSED_THRESHOLD = 0.8;
const CO_OCCURRENCE_CAP = 3;
const SAMPLE_LESSONS_CAP = 3;

interface SuggestionsFile {
  schema_version: 1;
  topics: Record<
    string,
    {
      count: number;
      first_seen: string;
      last_seen: string;
      lessons: string[];
    }
  >;
}

function loadSuggestions(suggestionsPath: string): SuggestionsFile['topics'] {
  if (!existsSync(suggestionsPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(suggestionsPath, 'utf8'));
    if (raw?.schema_version === 1 && raw.topics && typeof raw.topics === 'object') {
      return raw.topics;
    }
  } catch {
    // ignore malformed
  }
  return {};
}

export function computeVocabStats(lessonsDir: string): VocabStats {
  // Load all valid lessons. Skip _-prefixed metadata files.
  const files = existsSync(lessonsDir)
    ? readdirSync(lessonsDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    : [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: { date: string; topics: TopicT[] }[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(lessonsDir, f), 'utf8'));
      const result = Lesson.safeParse(raw);
      if (result.success) {
        parsed.push({ date: result.data.date, topics: [...result.data.topics] });
      }
    } catch {
      // skip
    }
  }

  const total = parsed.length;
  const topicless = parsed.filter((l) => l.topics.length === 0).length;
  const totalTopicTokens = parsed.reduce((sum, l) => sum + l.topics.length, 0);
  const avgTopics = total === 0 ? 0 : totalTopicTokens / total;

  // Per-topic statistics.
  const usage = new Map<TopicT, TopicUsage>();
  for (const t of TOPIC_VOCAB) {
    usage.set(t, {
      topic: t,
      count: 0,
      density: 0,
      first_used: null,
      last_used: null,
      co_occurrence: [],
    });
  }

  // Co-occurrence matrix: { topic: { otherTopic: count } }.
  const coMatrix = new Map<TopicT, Map<TopicT, number>>();
  for (const t of TOPIC_VOCAB) coMatrix.set(t, new Map());

  for (const lesson of parsed) {
    for (const t of lesson.topics) {
      const u = usage.get(t);
      if (!u) continue;
      u.count += 1;
      if (!u.first_used || lesson.date < u.first_used) u.first_used = lesson.date;
      if (!u.last_used || lesson.date > u.last_used) u.last_used = lesson.date;

      // Bump co-occurrence with every other topic in the same lesson.
      const row = coMatrix.get(t);
      if (row) {
        for (const other of lesson.topics) {
          if (other === t) continue;
          row.set(other, (row.get(other) ?? 0) + 1);
        }
      }
    }
  }

  // Densities + top co-occurrence per topic.
  for (const u of usage.values()) {
    u.density = total === 0 ? 0 : u.count / total;
    const row = coMatrix.get(u.topic);
    if (row) {
      u.co_occurrence = [...row.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, CO_OCCURRENCE_CAP)
        .map(([topic, count]) => ({ topic, count }));
    }
  }

  const topicUsage = [...usage.values()].sort((a, b) => b.count - a.count);
  const unused = topicUsage.filter((u) => u.count === 0).map((u) => u.topic);
  const overused = topicUsage
    .filter((u) => u.density > OVERUSED_THRESHOLD)
    .map((u) => u.topic);

  // Accumulated AI suggestions, capped sample_lessons for payload size.
  const suggestionsPath = join(lessonsDir, '_topics-suggestions.json');
  const suggestionsRaw = loadSuggestions(suggestionsPath);
  const accumulatedSuggestions: AccumulatedSuggestion[] = Object.entries(suggestionsRaw)
    .map(([topic, entry]) => ({
      topic,
      count: entry.count,
      first_seen: entry.first_seen,
      last_seen: entry.last_seen,
      sample_lessons: entry.lessons.slice(0, SAMPLE_LESSONS_CAP),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    total_lessons: total,
    total_topicless: topicless,
    avg_topics_per_lesson: Math.round(avgTopics * 100) / 100,
    vocab_size: TOPIC_VOCAB.length,
    topic_usage: topicUsage,
    unused_topics: unused,
    overused_topics: overused,
    accumulated_suggestions: accumulatedSuggestions,
    computed_at: new Date().toISOString(),
  };
}

// Render stats as a compact text block for AI consumption. Targets ~2-5 KB
// regardless of corpus size (lesson count doesn't enter the payload — only
// per-topic aggregates and the suggestions list).
export function renderStatsForAI(stats: VocabStats): string {
  const lines: string[] = [];
  lines.push(`CORPUS HEALTH`);
  lines.push(`  Total lessons: ${stats.total_lessons}`);
  lines.push(`  Topicless lessons: ${stats.total_topicless}`);
  lines.push(`  Avg topics/lesson: ${stats.avg_topics_per_lesson}`);
  lines.push(`  Vocab size: ${stats.vocab_size}`);
  lines.push('');
  lines.push(`TOPIC USAGE (sorted by count desc):`);
  for (const u of stats.topic_usage) {
    const co =
      u.co_occurrence.length > 0
        ? ` co: ${u.co_occurrence.map((c) => `${c.topic}×${c.count}`).join(', ')}`
        : '';
    const dates =
      u.first_used && u.last_used
        ? ` (${u.first_used}…${u.last_used})`
        : '';
    const dens = (u.density * 100).toFixed(0);
    lines.push(`  ${u.topic}: ${u.count}/${stats.total_lessons} (${dens}%)${dates}${co}`);
  }
  lines.push('');
  if (stats.unused_topics.length > 0) {
    lines.push(`UNUSED TOPICS (0 lessons): ${stats.unused_topics.join(', ')}`);
  }
  if (stats.overused_topics.length > 0) {
    lines.push(
      `OVERUSED TOPICS (>${OVERUSED_THRESHOLD * 100}% density): ${stats.overused_topics.join(', ')}`,
    );
  }
  lines.push('');
  if (stats.accumulated_suggestions.length > 0) {
    lines.push(`PER-LESSON AI SUGGESTIONS (accumulated, sorted by count):`);
    for (const s of stats.accumulated_suggestions) {
      lines.push(
        `  ${s.topic}: ${s.count}× since ${s.first_seen} (e.g. ${s.sample_lessons.join(', ')})`,
      );
    }
  } else {
    lines.push(`PER-LESSON AI SUGGESTIONS: (none accumulated yet)`);
  }
  return lines.join('\n');
}
