// Slug uniqueness for generated lessons.
//
// The slug is model-generated in extract.ts and only regex-validated. The SPA
// routes `/lesson/:slug`, the manifest lookup takes the first match, and
// cheatsheet.json keys processed lessons by slug — so two lessons sharing a
// slug silently shadow each other. This picks a free slug before
// the lesson is written.

/**
 * Return `slug` if no lesson uses it, otherwise the first free
 * `slug-2`, `slug-3`, … variant.
 *
 * `existing` maps slug → file name for every committed lesson.
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
  _date: string,
  existing: ReadonlyMap<string, string>,
): string {
  const takenByAnother = (candidate: string): boolean => {
    return existing.has(candidate);
  };

  if (!takenByAnother(slug)) return slug;

  for (let n = 2; n < 100; n++) {
    const candidate = `${slug}-${n}`;
    if (!takenByAnother(candidate)) return candidate;
  }
  throw new Error(`Could not find a free slug for "${slug}" after 99 attempts.`);
}
