// Applies the saved/preferred theme before first paint so night-mode users
// don't get a light flash while the Angular bundle loads.
//
// Lives in its own file (served from /theme-init.js) rather than inline in
// index.html because public/_headers ships `script-src 'self'` with no
// nonce/hash — an inline script is blocked by that CSP (issue #67).
// AppComponent re-reads the same localStorage key and takes over from here.
(function () {
  try {
    var saved = localStorage.getItem('lj-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = saved === 'night' || saved === 'day' ? saved : prefersDark ? 'night' : 'day';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    // localStorage can throw (privacy mode / blocked storage). Fall back to
    // the system preference only.
    document.documentElement.setAttribute(
      'data-theme',
      window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day',
    );
  }
})();
