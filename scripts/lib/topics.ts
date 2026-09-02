import { TOPIC_VOCAB, type TopicT } from '../../src/lib/schema.ts';

type PatternMap = Record<TopicT, RegExp[]>;

const PATTERNS: PatternMap = {
  grammar: [/\bgrammar\b/i, /граматик/i, /грамматик/i, /\bconjugat/i, /\bdeclens/i],
  vocabulary: [/\bvocabular/i, /\blexicon\b/i, /словник/i, /лексик/i, /\bword list\b/i],
  pronunciation: [/\bpronunc/i, /\bphonetic/i, /вимов/i, /произнош/i, /\bstress\b/i, /\baccent\b/i],
  conversation: [/\bdialog/i, /\bconversation\b/i, /діалог/i, /разговор/i, /\brole.?play\b/i],
  reading: [/\breading\b/i, /\btext\b/i, /читанн/i, /чтение/i],
  listening: [/\blisten/i, /аудіюван/i, /аудирован/i, /\baudio\b/i],
};

// Detect topics from raw transcript or article text.
export function detectTopics(text: string): TopicT[] {
  const found: TopicT[] = [];
  for (const id of TOPIC_VOCAB) {
    if (PATTERNS[id].some((re) => re.test(text))) found.push(id);
  }
  return found;
}

export function formatTopics(topics: readonly TopicT[]): string {
  return topics.length === 0 ? '(none)' : topics.join(', ');
}
