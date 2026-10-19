/**
 * Runs in the sign-in popup after Google / Microsoft redirect back (see
 * src/core/storage-adapters/oauth.js). Hands the result to the app window over a same-origin
 * BroadcastChannel, wipes it from the address bar and closes.
 */
(function () {
  var url = new URL(window.location.href);
  var params = {};
  new URLSearchParams(url.search).forEach(function (v, k) { params[k] = v; });
  new URLSearchParams(url.hash.replace(/^#/, '')).forEach(function (v, k) { params[k] = v; });
  history.replaceState(null, '', url.pathname);

  var status = document.getElementById('kb-oauth-status');
  if (!params.state) {
    status.textContent = 'Nothing to do here. You can close this window.';
    return;
  }
  var channel = new BroadcastChannel('kb-oauth');
  channel.postMessage(params);
  channel.close();
  status.textContent = params.error ? 'Sign-in was cancelled. You can close this window.' : 'Signed in. You can close this window.';
  setTimeout(function () { window.close(); }, 300);
})();
