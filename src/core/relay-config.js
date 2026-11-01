/**
 * School relay connection helpers (Settings → School sync server, #/connect).
 *
 * Pure-ish and dependency-free so they can be unit-tested with a mocked `fetch`:
 * URL validation, the CSP `connect-src` hint, and "Test connection", which checks
 * `GET /health` (is a relay there?) and `GET /whoami` (does the token work?).
 */

const HEALTH_TIMEOUT_MS = 10000;

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./
];

/** localhost, *.localhost, *.local (mDNS), loopback and private-network addresses */
export function isLocalOrPrivateHost(hostname = '') {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return PRIVATE_V4.some(re => re.test(h));
}

/**
 * Validate and normalise a relay address typed by a teacher.
 * https is required, except for local and private-network addresses (school LAN relays).
 * @param {string} input
 * @returns {{ ok: boolean, url?: string, origin?: string, error?: string }}
 */
export function validateRelayUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter the server address, e.g. https://relay.myschool.edu' };
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (_) {
    return { ok: false, error: 'That is not a valid address. Use a form like https://relay.myschool.edu' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'The address must start with https://' };
  }
  if (u.protocol === 'http:' && !isLocalOrPrivateHost(u.hostname)) {
    return {
      ok: false,
      error: 'Use https:// for a server on the internet. Plain http:// is only allowed for localhost, .local names and private network addresses.'
    };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'Do not put a username or password in the address. Use the teacher token field.' };
  }
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${u.origin}${path === '/' ? '' : path}`, origin: u.origin };
}

/** The exact connect-src value to add to the app's Content Security Policy */
export function cspConnectSrcLine(baseUrl) {
  const v = validateRelayUrl(baseUrl);
  const origin = v.origin || String(baseUrl || '').replace(/\/+$/, '');
  return `connect-src 'self' data: ${origin}`;
}

/** Same rule as RelayTransport.apiBase */
export function relayApiBase(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

// Remember the last CSP block so a failed fetch can be explained precisely
let lastCspViolation = null;
if (typeof document !== 'undefined' && !globalThis.__kbRelayCspListener) {
  globalThis.__kbRelayCspListener = true;
  try {
    document.addEventListener('securitypolicyviolation', (e) => {
      if (e.effectiveDirective === 'connect-src') lastCspViolation = { uri: e.blockedURI, at: Date.now() };
    });
  } catch (_) {}
}

function cspBlocked(baseUrl) {
  let origin = '';
  try { origin = new URL(baseUrl).origin; } catch (_) {}
  return Boolean(lastCspViolation && origin && Date.now() - lastCspViolation.at < 10000 && String(lastCspViolation.uri).startsWith(origin));
}

async function timedFetch(fetchImpl, url, init = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, { ...init, ...(ctrl ? { signal: ctrl.signal } : {}) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Turn a failed request into something a teacher can act on */
export function explainRelayFailure({ code, baseUrl, status, detail } = {}) {
  const origin = (() => { try { return new URL(baseUrl).origin; } catch (_) { return baseUrl || 'the server'; } })();
  switch (code) {
    case 'csp':
      return `${origin} is not on this installation's allow-list (Content Security Policy). Ask whoever hosts KennisBoost to add it: ${cspConnectSrcLine(baseUrl)}. For the bundled server set KB_RELAY_ORIGIN, on static hosting run "npm run csp" with KB_RELAY_ORIGIN, or serve the app from the relay with KB_RELAY_SERVE_APP=1.`;
    case 'timeout':
      return `${origin} did not answer in time. Check that the server is running and reachable from this network.`;
    case 'network':
      return `Could not reach ${origin}. Check the address and that the server is running. If it is, the server's allowed origins (KB_RELAY_ORIGINS, CORS) or this app's Content Security Policy may be blocking it. The CSP entry would be: ${cspConnectSrcLine(baseUrl)}`;
    case 'bad_health':
      return `${origin} answered, but it does not look like a KennisBoost relay${status ? ` (HTTP ${status})` : ''}. Check the address.`;
    case 'unauthorized':
      return 'The teacher token was rejected (401). Check that you pasted the whole token and that it belongs to this server. Ask your administrator for a new one if needed.';
    case 'forbidden':
      return 'The teacher token was refused (403). Ask your administrator to check your teacher account.';
    case 'whoami_missing':
      return 'This server is reachable but is too old to verify your token (it has no /whoami route). Update the relay to the current version.';
    case 'quota':
      return 'This teacher account is over its storage quota on the server (507). Free up space under Devices & sync, or ask your administrator to raise KB_RELAY_TEACHER_QUOTA_MB.';
    case 'clock':
      return 'The server rejected the request because of a large clock difference. Check the date and time on this device.';
    default:
      return detail || (status ? `The server returned HTTP ${status}.` : 'Unknown error.');
  }
}

/**
 * Test a relay connection: /health, then /whoami with the token.
 * Never throws; inspect `ok`, `stage` ('url'|'health'|'whoami'|'done'), `code` and `error`.
 *
 * @param {{ baseUrl: string, token?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export async function testRelayConnection({ baseUrl, token = '', fetchImpl, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const v = validateRelayUrl(baseUrl);
  if (!v.ok) return { ok: false, stage: 'url', code: 'invalid_url', error: v.error };
  if (!f) return { ok: false, stage: 'url', code: 'network', error: 'This browser cannot make network requests.' };
  const api = relayApiBase(v.url);
  const fail = (stage, code, extra = {}) => ({ ok: false, stage, code, error: explainRelayFailure({ code, baseUrl: v.url, ...extra }), ...extra });
  const netCode = (err) => (err?.name === 'AbortError' ? 'timeout' : cspBlocked(v.url) ? 'csp' : 'network');

  let health;
  try {
    const res = await timedFetch(f, `${api}/health`, {}, timeoutMs);
    if (!res.ok) return fail('health', 'bad_health', { status: res.status });
    health = await res.json().catch(() => null);
    if (!health || health.ok === false) return fail('health', 'bad_health', { status: res.status });
  } catch (err) {
    return fail('health', netCode(err), { detail: err?.message });
  }
  const healthInfo = {
    version: health.version || null,
    schemaVersion: health.schema_version ?? null,
    backend: health.backend || null,
    blobStore: health.blobStore || null,
    limits: health.limits || null,
    features: Array.isArray(health.features) ? health.features : []
  };

  if (!String(token || '').trim()) {
    return { ok: false, stage: 'whoami', code: 'no_token', error: 'Paste your teacher token to finish the test.', health: healthInfo };
  }

  let whoami;
  try {
    const res = await timedFetch(f, `${api}/whoami`, { headers: { Authorization: `Bearer ${String(token).trim()}` } }, timeoutMs);
    if (res.status === 401) return { ...fail('whoami', 'unauthorized', { status: 401 }), health: healthInfo };
    if (res.status === 403) return { ...fail('whoami', 'forbidden', { status: 403 }), health: healthInfo };
    if (res.status === 404) return { ...fail('whoami', 'whoami_missing', { status: 404 }), health: healthInfo };
    if (res.status === 507) return { ...fail('whoami', 'quota', { status: 507 }), health: healthInfo };
    if (!res.ok) return { ...fail('whoami', 'http', { status: res.status }), health: healthInfo };
    whoami = await res.json().catch(() => null);
    if (!whoami || !whoami.teacher_id) return { ...fail('whoami', 'http', { status: res.status, detail: 'The server did not return a teacher id.' }), health: healthInfo };
  } catch (err) {
    return { ...fail('whoami', netCode(err), { detail: err?.message }), health: healthInfo };
  }

  return {
    ok: true,
    stage: 'done',
    health: healthInfo,
    whoami: {
      teacherId: whoami.teacher_id,
      name: whoami.name || '',
      quota: whoami.quota && typeof whoami.quota === 'object' ? { used: Number(whoami.quota.used) || 0, limit: Number(whoami.quota.limit) || 0 } : null
    }
  };
}

/**
 * Storage used by this teacher on the relay (GET /usage). Returns null when unavailable.
 */
export async function fetchRelayUsage({ baseUrl, token, fetchImpl, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!f || !baseUrl || !token) return null;
  try {
    const res = await timedFetch(f, `${relayApiBase(baseUrl)}/usage`, { headers: { Authorization: `Bearer ${token}` } }, timeoutMs);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/** "123.4 MB" style size */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Same as the compare the connect flow uses to decide whether a link would change anything */
export function sameRelayConfig(a, b) {
  if (!a?.baseUrl || !b?.baseUrl) return false;
  const norm = (u) => String(u).trim().replace(/\/+$/, '').toLowerCase();
  return norm(a.baseUrl) === norm(b.baseUrl) && String(a.token || '') === String(b.token || '') && String(a.teacherId || '') === String(b.teacherId || '');
}
