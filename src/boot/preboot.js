/**
 * Pre-boot (classic, render-blocking script).
 *
 * Kept out of index.html so the Content Security Policy needs no 'unsafe-inline' for scripts.
 *  1. Apply the saved theme before first paint to avoid a light flash in dark mode.
 *  2. Show friendly instructions when the app is opened straight from disk (file://), where
 *     browsers block ES modules and IndexedDB.
 */
(function () {
  try {
    var t = localStorage.getItem('kb_theme_mode') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var c = document.documentElement.classList;
    c.remove('sl-theme-light');
    c.add(dark ? 'sl-theme-dark' : 'sl-theme-light');
    if (t === 'projector') c.add('kb-theme-projector');
  } catch (e) {}

  if (window.location.protocol !== 'file:') return;

  document.addEventListener('DOMContentLoaded', function () {
    var container = document.getElementById('app-view-container');
    if (!container) return;
    container.innerHTML =
      '<div class="kb-file-guard">' +
        '<div class="kb-file-guard-icon" aria-hidden="true">🚀</div>' +
        '<h2>Local Web Server Required</h2>' +
        '<p>You opened KennisBoost Tools directly from the filesystem (<code>file://</code>). Web browsers block ES modules and IndexedDB storage on direct file paths for security.</p>' +
        '<div class="kb-file-guard-cmd"><p># Run this command in your project terminal:</p><p><strong>npm start</strong></p></div>' +
        '<p>Once the server is running, open:</p>' +
        '<a href="http://localhost:8000">Open http://localhost:8000</a>' +
      '</div>';
  });
})();
