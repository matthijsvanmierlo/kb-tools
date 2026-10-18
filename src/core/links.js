/**
 * LinkBuilder - KB-CORE-LINKS
 * Central link composition, parameter encoding, and length measurement.
 */

import { CryptoShareEngine } from './crypto-share.js';
import { AccessCodes } from './access-codes.js';

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
   * Encrypts with student's access code if available, otherwise student ID.
   *
   * @param {object} feedbackPayload
   * @param {object} student
   * @returns {Promise<{ url: string, exceedsUrlLimit: boolean, rawFileContent: string, length: number }>}
   */
  static async feedback(feedbackPayload, student) {
    const pass = AccessCodes.reportPassphrase(student || {});
    return CryptoShareEngine.createSharePayload('assignment_feedback', feedbackPayload, pass);
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

export default LinkBuilder;
