/**
 * Browser-only OAuth helpers for the cloud backup adapters, with no third-party SDK or script
 * (the CSP forbids them): a sign-in popup returns to oauth-callback.html, which hands the result
 * back over a same-origin BroadcastChannel. window.opener can't be used because the popup passes
 * through the provider's origin, and Cross-Origin-Opener-Policy severs that link.
 */

export const OAUTH_CHANNEL = 'kb-oauth';

export class CloudAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CloudAuthError';
    this.code = code;
  }
}

export function base64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(byteLength = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** RFC 7636 PKCE: random verifier and its S256 challenge */
export async function pkceChallenge(verifier) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export async function createPkce() {
  const verifier = randomString(32);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/** The callback page next to index.html; IT registers this exact URL with Google / Microsoft */
export function redirectUri(href = typeof location !== 'undefined' ? location.href : 'http://localhost/') {
  const url = new URL('oauth-callback.html', href);
  url.hash = '';
  url.search = '';
  return url.href;
}

/** Query and fragment parameters of a callback URL, merged (implicit flow uses the fragment) */
export function parseCallbackParams(href) {
  const url = new URL(href);
  return Object.fromEntries([
    ...new URLSearchParams(url.search),
    ...new URLSearchParams(url.hash.replace(/^#/, ''))
  ]);
}

/**
 * Open the provider's sign-in page and wait for the callback page to report back.
 * Must be called from a click (popup blockers). Resolves with the callback parameters.
 */
export function openAuthPopup(url, state, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(OAUTH_CHANNEL);
    const popup = window.open(url, 'kb-oauth', 'popup,width=520,height=680');
    if (!popup) {
      channel.close();
      reject(new CloudAuthError('POPUP_BLOCKED', 'Allow pop-ups for this site to sign in.'));
      return;
    }
    const timer = setTimeout(() => {
      channel.close();
      reject(new CloudAuthError('TIMEOUT', 'Sign-in took too long. Please try again.'));
    }, timeoutMs);
    channel.onmessage = (e) => {
      if (!e.data || e.data.state !== state) return;
      clearTimeout(timer);
      channel.close();
      if (e.data.error) {
        reject(new CloudAuthError('DENIED', e.data.error_description || 'Sign-in was cancelled.'));
      } else {
        resolve(e.data);
      }
    };
  });
}

/** Stored tokens are device-bound metadata (see backup.js DEVICE_BOUND_METADATA) */
export class TokenStore {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }

  async get() {
    return (await this.store.getMetadata(this.key)) || null;
  }

  async save({ access_token, expires_in, refresh_token }, previous = null) {
    const entry = {
      access_token,
      // Refresh a minute early so a request never starts with a token about to expire
      expires_at: Date.now() + Math.max(0, (Number(expires_in) || 3600) - 60) * 1000,
      refresh_token: refresh_token || previous?.refresh_token || null
    };
    await this.store.setMetadata(this.key, entry);
    return entry;
  }

  async clear() {
    await this.store.setMetadata(this.key, null);
  }

  static isValid(entry, now = Date.now()) {
    return Boolean(entry?.access_token && entry.expires_at > now);
  }
}
