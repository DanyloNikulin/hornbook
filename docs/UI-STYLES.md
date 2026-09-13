# Shared UI styles

The pair chooser and application pages use the same paper surface and typography.

- `src/styles.scss` owns theme tokens, the page panel, section titles, buttons,
  chips and pills. `--page-max-width` and `--page-gutter` align the panel and hero.
- `src/app/shared.scss` owns page headers, back links, search fields, content
  states and link cards. Feature stylesheets should not redefine these basics.
- Use `il-panel` for the outer page and optionally `il-panel-inner` for a wrapper.
  The route shell lets short panels fill the available height; avoid `100vh`
  inside a page or a separate page width/padding.
- Use `il-page-head`, `il-section-title`, `il-section-sub`, and `il-back-link`.
  Put title/actions in `il-page-title-row` for the shared mobile stacking rule.
- Wrap a search input in a labelled `il-search-field`. Use
  `il-search-field--compact` only for a narrow reference rail. The wrapper owns
  the border, focus treatment and input typography.
- Use `il-content-state` for loading, failure or empty search/reference results.
  Keep `il-empty-state` for onboarding with an explanation and primary action.
- Use `il-card` for navigable pair/lesson cards, then add feature content styles.
  Use theme tokens for surfaces and borders; derive accent tints with `color-mix`
  so custom pair themes work in both day and night modes.

The Lessons hero, lesson reading layout, Sheet rail and study cards have distinct
jobs and retain their own layouts. Do not force their internal content into a
generic card or header. Keep accessibility preferences in `accessibility.scss`;
normal responsive control sizing belongs in the base control styles.
