import { storage } from './storage.js';

/**
 * App URL Resolution (KB-CORE-APPURL)
 *
 * Resolves the public address of the app for links and standalone HTML launchers.
 * Order of precedence:
 *  1. window.KB_CONFIG?.appUrl
 *  2. app_metadata.public_app_url
 *  3. location.origin + location.pathname (when not local: localhost, 127.*, [::1], file:)
 *  4. null
 */

export function isLocalOrigin(urlOrOrigin) {
  if (!urlOrOrigin) return false;
  try {
    const str = String(urlOrOrigin).trim();
    if (str.startsWith('file:')) return true;
    const u = new URL(str, 'http://localhost');
    const h = u.hostname.toLowerCase();
    return (
      u.protocol === 'file:' ||
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h.startsWith('127.') ||
      h === '[::1]' ||
      h === '::1' ||
      h === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

export async function getPublicAppUrl(storageInstance = storage) {
  if (typeof window !== 'undefined' && window.KB_CONFIG?.appUrl) {
    const configured = String(window.KB_CONFIG.appUrl).trim();
    if (configured) return configured;
  }

  if (storageInstance && typeof storageInstance.getMetadata === 'function') {
    try {
      const stored = await storageInstance.getMetadata('public_app_url');
      if (stored && typeof stored === 'string' && stored.trim().length > 0) {
        return stored.trim();
      }
    } catch (_) {}
  }

  if (typeof window !== 'undefined' && window.location) {
    const loc = window.location;
    if (loc.protocol !== 'file:' && !isLocalOrigin(loc.href)) {
      return `${loc.origin}${loc.pathname}`;
    }
  }

  return null;
}

export async function setPublicAppUrl(url, storageInstance = storage) {
  if (storageInstance && typeof storageInstance.setMetadata === 'function') {
    await storageInstance.setMetadata('public_app_url', url ? String(url).trim() : null);
  }
}
