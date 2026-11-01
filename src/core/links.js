/**
 * LinkBuilder - KB-CORE-LINKS
 * Central link composition, parameter encoding, and length measurement.
 */

import { CryptoShareEngine } from './crypto-share.js';
import { AccessCodes, normalizeAccessCode } from './access-codes.js';

export class LinkBuilder {
  /**
   * Append query parameters to a link cleanly (preserving existing query params in hash or search).
   * In KennisBoost, routes live in the hash (e.g. `#/share?enc=1&d=...`).
   *
   * @param {string} url
   * @param {Record<string, string|number|boolean|null|undefined>} params
   * @returns {string}
   */
  static withParams(url, params = {}) {
    if (!url) return '';
    const hashIndex = url.indexOf('#');
    if (hashIndex === -1) {
      // URL without hash
      try {
        const u = new URL(url, 'https://kennisboost.local');
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== null && v !== '') {
            u.searchParams.set(k, String(v));
          }
        }
        return url.startsWith('http') ? u.toString() : (u.pathname + u.search);
      } catch (_) {
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
        }
        const qs = sp.toString();
        return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
      }
    }

    const prefix = url.slice(0, hashIndex);
    const hash = url.slice(hashIndex);
    const qIndex = hash.indexOf('?');
    const path = qIndex === -1 ? hash : hash.slice(0, qIndex);
    const qs = qIndex === -1 ? '' : hash.slice(qIndex + 1);

    const sp = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        sp.set(k, String(v));
      }
    }
    const query = sp.toString();
    return `${prefix}${path}${query ? '?' + query : ''}`;
  }

  /**
   * Measure the character length of a URL.
   * @param {string} url
   * @returns {number}
   */
  static measureLength(url) {
    return typeof url === 'string' ? url.length : 0;
  }

  /**
   * Create an encrypted assignment feedback share link.
   * Encrypts with the student's access code, creating one first if they have none.
   *
   * @param {object} feedbackPayload
   * @param {object} student
   * @returns {Promise<{ url: string, exceedsUrlLimit: boolean, rawFileContent: string, length: number, generatedAccessCode: string|null }>}
   */
  static async feedback(feedbackPayload, student, shareType = 'assignment_feedback') {
    const generatedAccessCode = await AccessCodes.ensureForStudent(student);
    const result = await CryptoShareEngine.createSharePayload(shareType, feedbackPayload, AccessCodes.reportPassphrase(student));
    return { ...result, generatedAccessCode };
  }

  /**
   * Create a hosted short link referencing a relay server payload.
   * The decryption key is embedded in the URL fragment (#) so it never reaches the server.
   *
   * @param {string} ref
   * @param {string} key
   * @param {string} [origin]
   * @returns {string}
   */
  static hosted(ref, key, origin) {
    let base = origin;
    let pathname = '';
    if (!base && typeof window !== 'undefined' && window.location) {
      base = window.location.origin;
      pathname = window.location.pathname || '';
    } else if (base) {
      try {
        const u = new URL(base, 'https://kennisboost.local');
        base = u.origin;
        pathname = u.pathname;
      } catch {
        pathname = '';
      }
    } else {
      base = 'https://kennisboost.local';
      pathname = '/';
    }
    if (pathname && !pathname.startsWith('/')) pathname = '/' + pathname;
    const pathPrefix = `${base.replace(/\/+$/, '')}${pathname}`;
    return `${pathPrefix}#/share?ref=${encodeURIComponent(ref)}&k=${encodeURIComponent(key)}`;
  }
}

/**
 * Safely decode base64url JSON payload
 */
function decodeB64UrlJson(str) {
  try {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const jsonStr = atob(b64);
    return JSON.parse(jsonStr);
  } catch (_) {
    return null;
  }
}

/**
 * Encode object to base64url JSON
 */
function encodeB64UrlJson(obj) {
  try {
    const jsonStr = JSON.stringify(obj);
    return btoa(jsonStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (_) {
    return '';
  }
}

/**
 * Unified Join Link Parser (KB-ROSTER-001)
 * Parses kennisboost://join?..., https://<relay>/join?..., https://<app>/#join=...
 * or fragment-only #join=... and returns a structured JoinIntent.
 *
 * @param {string} rawUrl
 * @returns {{ type: 'join', classCode: string|null, personalCode: string|null, relay: string|null, feedId: string|null, key: string|null } | null}
 */
export function parseJoinLink(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let classCode = null;
  let personalCode = null;
  let relay = null;
  let feedId = null;
  let key = null;

  // 1. Fragment-only or URL with #join=...
  if (trimmed.includes('#join=')) {
    const after = trimmed.slice(trimmed.indexOf('#join=') + 6);
    const decoded = decodeB64UrlJson(after);
    if (decoded && typeof decoded === 'object') {
      classCode = decoded.c || decoded.classCode || decoded.class_code || null;
      personalCode = decoded.s || decoded.personalCode || decoded.access_code || decoded.studentCode || null;
      relay = decoded.r || decoded.relay || decoded.relayUrl || null;
      feedId = decoded.f || decoded.feedId || decoded.feed_id || null;
      key = decoded.k || decoded.key || null;
    }
  }

  // 2. URL parsing (kennisboost://join?..., https://.../join?..., #/student?code=...)
  if (!classCode && !feedId) {
    try {
      const parseable = trimmed.startsWith('#')
        ? `https://kennisboost.local/${trimmed.replace(/^#\/?/, '')}`
        : (trimmed.startsWith('/') ? `https://kennisboost.local${trimmed}` : trimmed);

      const u = new URL(parseable, 'https://kennisboost.local');
      const sp = u.searchParams;

      classCode = sp.get('c') || sp.get('code') || sp.get('classCode') || sp.get('class_code');
      personalCode = sp.get('s') || sp.get('personalCode') || sp.get('access_code') || sp.get('studentCode');
      relay = sp.get('r') || sp.get('relay') || sp.get('relayUrl');
      feedId = sp.get('f') || sp.get('feedId') || sp.get('feed_id');
      key = sp.get('k') || sp.get('key');

      if (u.hash && (!classCode || !personalCode)) {
        const hQIndex = u.hash.indexOf('?');
        if (hQIndex >= 0) {
          const hsp = new URLSearchParams(u.hash.slice(hQIndex + 1));
          classCode = classCode || hsp.get('c') || hsp.get('code') || hsp.get('classCode') || hsp.get('class_code');
          personalCode = personalCode || hsp.get('s') || hsp.get('personalCode') || hsp.get('access_code') || hsp.get('studentCode');
          relay = relay || hsp.get('r') || hsp.get('relay') || hsp.get('relayUrl');
          feedId = feedId || hsp.get('f') || hsp.get('feedId') || hsp.get('feed_id');
          key = key || hsp.get('k') || hsp.get('key');
        }
      }

      if (!classCode) {
        const parts = u.pathname.split('/').filter(Boolean);
        const joinIdx = parts.indexOf('join');
        if (joinIdx >= 0 && parts[joinIdx + 1]) {
          classCode = parts[joinIdx + 1];
        }
      }
    } catch (_) {}
  }

  // 3. Raw class code directly entered (e.g. "ABCD-EFGH" or Crockford 8-10 chars)
  if (!classCode && !feedId && /^[A-Za-z0-9_-]{4,16}$/.test(trimmed)) {
    classCode = trimmed;
  }

  if (!classCode && !feedId) return null;

  return {
    type: 'join',
    classCode: classCode ? normalizeAccessCode(classCode) : null,
    personalCode: personalCode ? normalizeAccessCode(personalCode) : null,
    relay: relay ? relay.trim() : null,
    feedId: feedId ? feedId.trim() : null,
    key: key ? key.trim() : null
  };
}

/**
 * Build a canonical join URL
 */
export function buildJoinLink({ classCode, relayUrl = null, studentCode = null, feedId = null, key = null, appHost = null } = {}) {
  const payload = {};
  if (classCode) payload.c = classCode;
  if (relayUrl) payload.r = relayUrl;
  if (studentCode) payload.s = studentCode;
  if (feedId) payload.f = feedId;
  if (key) payload.k = key;

  const b64 = encodeB64UrlJson(payload);
  const base = appHost || (typeof window !== 'undefined' && window.location ? window.location.origin : 'https://kennisboost.app');
  return `${base.replace(/\/+$/, '')}/#join=${b64}`;
}

export default LinkBuilder;
