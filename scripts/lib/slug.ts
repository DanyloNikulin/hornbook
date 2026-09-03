// Slug uniqueness for generated lessons.
//
// The slug is model-generated in extract.ts and only regex-validated. The SPA
// routes `/lesson/:slug`, the manifest lookup takes the first match, and
// cheatsheet.json keys processed lessons by slug — so two lessons sharing a
// slug silently shadow each other. This picks a free slug before
// the lesson is written.

/**
 * Return `slug` if no *other* lesson uses it, otherwise the first free
 * `slug-2`, `slug-3`, … variant.
 *
 * `existing` maps slug → file name for every committed lesson. A slug is not
 * considered taken when its file is exactly `${date}-${slug}.json`: that is
 * the lesson being re-processed, and process.ts overwrites it in place.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function ensureUniqueSlug(
  slug: string,
  date: string,
  existing: ReadonlyMap<string, string>,
): string {
  const takenByAnother = (candidate: string): boolean => {
    const file = existing.get(candidate);
    return file !== undefined && file !== `${date}-${candidate}.json`;
  };

  if (!takenByAnother(slug)) return slug;

  for (let n = 2; n < 100; n++) {
    const candidate = `${slug}-${n}`;
    if (!takenByAnother(candidate)) return candidate;
  }
  throw new Error(`Could not find a free slug for "${slug}" after 99 attempts.`);
}
