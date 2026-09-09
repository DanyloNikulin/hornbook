import { defineConfig } from 'vitest/config';

/**
 * The Node-side suite: pipeline scripts, the API server, the desktop shell and
 * the harness. Angular components run under `ng test` with its own builder.
 *
 * Positional filters (`vitest run scripts server electron harness`) matched any
 * path *containing* one of those words, so snapshots kept under the ignored
 * /work folder ran alongside the real suite and reported stale failures. These
 * globs are anchored instead.
 */
export default defineConfig({
  test: {
    include: ['{scripts,server,electron,harness}/**/*.spec.ts'],
  },
});
