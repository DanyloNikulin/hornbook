// Persistence layer for high-volume app state (SM-2 per-card state, daily
// counters, activity heatmap, quiz results). Backed by IndexedDB via
// idb-keyval — typed thin wrapper around get/set/del.
//
// localStorage was approaching Safari's 5 MB hard cap at ~156 lessons
// (SM-2 alone reaches ~1.4 MB), and setItem failures used to be silently
// swallowed by the services. IndexedDB has practical limits in the GB range
// and asynchronous quota errors we can actually log.
//
// Tiny single-key prefs (theme, direction, mode, level) continue to live in
// localStorage — moving them gains nothing and would add async overhead to
// UI init that is currently synchronous.

import * as idb from 'idb-keyval';

// Truthy if we are in an environment where the IndexedDB API exists. Used
// to keep server-side rendering, Node, and tests without a DOM shim happy.
function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

// Read a JSON-serialisable value from IndexedDB.
//
// Returns undefined when the key is absent OR when reading fails for any
// reason (no IDB, quota error, disk full, browser private-mode quirk).
// Callers fall back to their own default in that case.
export async function idbGet<T>(key: string): Promise<T | undefined> {
  if (!hasIndexedDB()) return undefined;
  try {
    return await idb.get<T>(key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[storage] idbGet failed for "${key}":`, err);
    return undefined;
  }
}

// Write a JSON-serialisable value to IndexedDB. Errors are logged but
// otherwise swallowed — same fire-and-forget semantics the localStorage
// version had, but at least observable in devtools.
export async function idbSet<T>(key: string, value: T): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    await idb.set(key, value);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[storage] idbSet failed for "${key}":`, err);
  }
}

// Delete a key from IndexedDB. Errors are logged and swallowed.
export async function idbDel(key: string): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    await idb.del(key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[storage] idbDel failed for "${key}":`, err);
  }
}

// One-time migration from localStorage to IndexedDB for a single key.
//
// Behaviour:
//   - If IndexedDB already has a value for `key`, no-op (assumed already
//     migrated or freshly written by a new user).
//   - If localStorage does not have `key`, no-op (fresh user, nothing to do).
//   - Otherwise: parse the localStorage value as JSON, write to IDB, then
//     delete the localStorage entry. If the JSON is malformed, drop the
//     legacy key so we don't keep trying to migrate junk on every boot.
//
// Idempotent — safe to call on every app boot. Returns the migrated value
// (or undefined when there was nothing to migrate or migration failed),
// so callers can avoid a second IDB read on the first run after deploy.
export async function migrateFromLocalStorage<T>(key: string): Promise<T | undefined> {
  if (!hasIndexedDB()) return undefined;
  if (typeof localStorage === 'undefined') return undefined;

  // If IDB already has a value, the migration has already run. We
  // intentionally don't read it here — callers do their own typed read
  // right after this returns, and we'd otherwise need to round-trip the
  // value through a generic parse.
  let existing: T | undefined;
  try {
    existing = await idb.get<T>(key);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[storage] migration probe failed for "${key}":`, err);
    return undefined;
  }
  if (existing !== undefined) return existing;

  // Fresh user with nothing in localStorage either — nothing to migrate.
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;

  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    // Legacy data is corrupt; remove it so subsequent boots aren't stuck
    // re-attempting the same broken migration.
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore — even cleanup failure is harmless
    }
    return undefined;
  }

  // Write to IDB BEFORE deleting from localStorage. If the write fails the
  // localStorage entry stays put and we'll retry on next boot — the user
  // hasn't lost anything.
  try {
    await idb.set(key, parsed);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[storage] migration write failed for "${key}":`, err);
    return undefined;
  }

  try {
    localStorage.removeItem(key);
  } catch {
    // ignore — IDB has the data, leftover localStorage entry is harmless
    // and will be cleaned up on the next successful boot.
  }

  return parsed;
}
