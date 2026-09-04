import { strFromU8, strToU8, unzipSync, zipSync, type UnzipFileInfo } from 'fflate';
import { z } from 'zod';
import { SectionConfig, type SectionConfigT } from '../src/lib/journal-config.ts';
import {
  Cheatsheet,
  Lesson,
  Progress,
  TopicCatalog,
  type CheatsheetT,
  type LessonT,
  type ProgressT,
  type TopicCatalogT,
} from '../src/lib/schema.ts';

export const MAX_SECTION_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 10_000;
const MANIFEST = 'hornbook-section.json';
export const BACKDROP_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif']);

const ArchiveManifest = z.object({
  format: z.literal('hornbook-section'),
  version: z.literal(1),
  exported_at: z.string().datetime(),
  includes_progress: z.boolean(),
  section: SectionConfig,
});

export interface SectionArchiveInput {
  section: SectionConfigT;
  lessons: readonly LessonT[];
  cheatsheet?: CheatsheetT;
  topics?: TopicCatalogT;
  progress?: ProgressT;
  backdrop?: { name: string; data: Uint8Array };
}

export interface SectionArchive extends SectionArchiveInput {
  exportedAt: string;
}

export function buildSectionArchive(input: SectionArchiveInput): Buffer {
  const section = SectionConfig.parse(input.section);
  const entries: Record<string, Uint8Array> = {};
  if (input.backdrop) {
    const name = archiveBackdropName(input.backdrop.name);
    section.theme = { ...section.theme, backdrop: name };
    entries[`backdrop/${name}`] = input.backdrop.data;
  }
  entries[MANIFEST] = jsonBytes({
    format: 'hornbook-section',
    version: 1,
    exported_at: new Date().toISOString(),
    includes_progress: input.progress !== undefined,
    section,
  });
  for (const raw of input.lessons) {
    const lesson = Lesson.parse(raw);
    entries[`lessons/${lesson.id}.json`] = jsonBytes(lesson);
  }
  if (input.cheatsheet) entries['cheatsheet.json'] = jsonBytes(Cheatsheet.parse(input.cheatsheet));
  if (input.topics) entries['topics.json'] = jsonBytes(TopicCatalog.parse(input.topics));
  if (input.progress) entries['progress.json'] = jsonBytes(Progress.parse(input.progress));
  return Buffer.from(zipSync(entries, { level: 6 }));
}

export function readSectionArchive(data: Uint8Array): SectionArchive {
  if (data.byteLength === 0) throw new Error('The pair archive is empty');
  if (data.byteLength > MAX_SECTION_ARCHIVE_BYTES) {
    throw new Error(`The pair archive is larger than ${MAX_SECTION_ARCHIVE_BYTES / 1024 / 1024} MB`);
  }
  let count = 0;
  let unpacked = 0;
  const filter = (file: UnzipFileInfo): boolean => {
    count += 1;
    unpacked += file.originalSize;
    if (count > MAX_ARCHIVE_FILES) throw new Error('The pair archive contains too many files');
    if (unpacked > MAX_UNPACKED_BYTES) throw new Error('The pair archive expands beyond the safety limit');
    return true;
  };
  const files = unzipSync(data, { filter });
  const actualUnpacked = Object.values(files).reduce((total, bytes) => total + bytes.byteLength, 0);
  if (actualUnpacked > MAX_UNPACKED_BYTES) throw new Error('The pair archive expands beyond the safety limit');
  const manifestBytes = files[MANIFEST];
  if (!manifestBytes) throw new Error(`The pair archive has no ${MANIFEST}`);
  const manifest = ArchiveManifest.parse(readJson(manifestBytes, MANIFEST));

  const lessons: LessonT[] = [];
  const slugs = new Set<string>();
  for (const [name, bytes] of Object.entries(files)) {
    if (!/^lessons\/[^/]+\.json$/.test(name)) continue;
    const lesson = Lesson.parse(readJson(bytes, name));
    if (slugs.has(lesson.slug)) throw new Error(`The pair archive contains lesson slug "${lesson.slug}" more than once`);
    slugs.add(lesson.slug);
    lessons.push(lesson);
  }

  const sourceBackdropName = manifest.section.theme?.backdrop;
  const backdropName = sourceBackdropName ? archiveBackdropName(sourceBackdropName) : undefined;
  const backdropBytes = sourceBackdropName ? files[`backdrop/${safeBasename(sourceBackdropName)}`] : undefined;
  if (sourceBackdropName && !backdropBytes) {
    throw new Error(`The pair archive is missing backdrop/${safeBasename(sourceBackdropName)}`);
  }
  const section = structuredClone(manifest.section);
  if (backdropName) section.theme = { ...section.theme, backdrop: backdropName };
  const progressBytes = files['progress.json'];
  if (manifest.includes_progress !== Boolean(progressBytes)) {
    throw new Error('The pair archive progress flag does not match its contents');
  }

  return {
    section,
    lessons,
    cheatsheet: optionalJson(files['cheatsheet.json'], 'cheatsheet.json', Cheatsheet),
    topics: optionalJson(files['topics.json'], 'topics.json', TopicCatalog),
    progress: optionalJson(progressBytes, 'progress.json', Progress),
    backdrop: backdropBytes && backdropName ? { name: backdropName, data: backdropBytes } : undefined,
    exportedAt: manifest.exported_at,
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function readJson(data: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(strFromU8(data));
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${(error as Error).message}`);
  }
}

function optionalJson<T>(data: Uint8Array | undefined, name: string, schema: z.ZodType<T>): T | undefined {
  return data ? schema.parse(readJson(data, name)) : undefined;
}

function safeBasename(name: string): string {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`Unsafe archive file name "${name}"`);
  }
  return name;
}

function archiveBackdropName(name: string): string {
  const basename = safeBasename(name);
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(basename)?.[1] ?? '').toLowerCase();
  if (!BACKDROP_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported archive backdrop type ".${ext || '(none)'}"`);
  }
  return `_backdrop.${ext}`;
}
