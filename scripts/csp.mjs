#!/usr/bin/env node
/**
 * Single source of truth for the Content Security Policy.
 *
 *   node scripts/csp.mjs        → rewrites the CSP <meta> in index.html and the static-host _headers
 *                                 file (run after editing the import map)
 *   KB_RELAY_ORIGIN=https://relay.myschool.edu npm run csp   → same, allowing a cross-origin relay
 *   KB_CLOUD_PROVIDERS=google,microsoft npm run csp            → same, allowing cloud backup APIs
 *   (a config.json next to index.html adds its relay and cloud providers automatically)
 *
 * Used by server.js (HTTP header, which can also carry frame-ancestors) and the security tests.
 *
 * Design notes (see revision-3.md §1):
 *  - script-src 'self' + the SHA-256 of the inline import map. No 'unsafe-inline', no 'unsafe-eval'.
 *  - connect-src 'self' data:  — Shoelace fetches its icon SVGs (system icons are data: URLs).
 *    Nothing can be sent to a third-party origin. A school relay on another origin must be listed
 *    explicitly (KB_RELAY_ORIGIN for server.js, or by editing the meta tag on static hosting).
 *  - frame-src only for the privacy-enhanced YouTube host and the Vimeo player (video module).
 *  - media-src https: because teachers link their own MP4/WebM files.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX_HTML = path.join(root, 'index.html');

export const VIDEO_FRAME_ORIGINS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'];

/** Optional cross-origin school relay(s), comma-separated: KB_RELAY_ORIGIN=https://relay.myschool.edu */
export function relayOriginsFromEnv(env = process.env) {
  return String(env.KB_RELAY_ORIGIN || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(s => new URL(s).origin);
}

/**
 * Cloud backup providers (storage-adapters/), comma-separated: KB_CLOUD_PROVIDERS=google,microsoft
 * OneDrive file downloads redirect to the tenant's SharePoint host, which can't be listed ahead
 * of time, hence the wildcard.
 */
export const CLOUD_ORIGINS = {
  google: ['https://www.googleapis.com'],
  microsoft: ['https://login.microsoftonline.com', 'https://graph.microsoft.com', 'https://*.sharepoint.com']
};

export function cloudOriginsFromEnv(env = process.env) {
  return String(env.KB_CLOUD_PROVIDERS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    .flatMap(p => {
      if (!CLOUD_ORIGINS[p]) throw new Error(`Unknown KB_CLOUD_PROVIDERS entry "${p}" (use google, microsoft)`);
      return CLOUD_ORIGINS[p];
    });
}

export const CONFIG_JSON = path.join(root, 'config.json');

/**
 * Origins implied by the managed config.json (docs/it-deployment.md): its relay and the cloud
 * providers it enables. A missing file means none; an unreadable one is an error.
 */
export function configOrigins(configPath = CONFIG_JSON) {
  if (!fs.existsSync(configPath)) return [];
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`${path.basename(configPath)} is not valid JSON: ${err.message}`);
  }
  const out = [];
  const relay = cfg.relay?.baseUrl || cfg.baseUrl;
  if (relay) out.push(new URL(relay).origin);
  if (cfg.cloud?.google?.clientId) out.push(...CLOUD_ORIGINS.google);
  if (cfg.cloud?.microsoft?.clientId) out.push(...CLOUD_ORIGINS.microsoft);
  return out;
}

/** Everything connect-src needs beyond 'self': relay plus enabled cloud providers (env and config.json) */
export function extraConnectOrigins(env = process.env, { configPath = CONFIG_JSON } = {}) {
  return [...new Set([...relayOriginsFromEnv(env), ...cloudOriginsFromEnv(env), ...configOrigins(configPath)])];
}

/** Hash of the inline import map exactly as the browser sees it (text between the tags). */
export function importMapHash(html) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Import map not found in index.html');
  return `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`;
}

/**
 * @param {object} opts
 * @param {string} opts.importMapHash
 * @param {string[]} [opts.relayOrigins] - extra connect-src origins for a cross-origin relay
 * @param {boolean} [opts.header] - include directives that only work as an HTTP header
 */
export function buildCsp({ importMapHash: hash, relayOrigins = [], header = false }) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", hash],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", 'data:', ...relayOrigins],
    'media-src': ["'self'", 'blob:', 'data:', 'https:'],
    'frame-src': VIDEO_FRAME_ORIGINS,
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"]
  };
  if (header) directives['frame-ancestors'] = ["'none'"];
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

export const HEADERS_FILE = path.join(root, '_headers');

/** Cloudflare Pages / Netlify `_headers`: the only way to send frame-ancestors on a static host */
export function staticHeadersFile(html, relayOrigins = []) {
  return [
    '# Generated by scripts/csp.mjs — do not edit by hand.',
    '/*',
    `  Content-Security-Policy: ${buildCsp({ importMapHash: importMapHash(html), relayOrigins, header: true })}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  X-Frame-Options: DENY',
    ''
  ].join('\n');
}

export function cspMetaTag(html, relayOrigins = []) {
  return `<meta http-equiv="Content-Security-Policy" content="${buildCsp({ importMapHash: importMapHash(html), relayOrigins })}">`;
}

/** Insert or refresh the CSP meta tag in an index.html string */
export function applyCspMeta(html, relayOrigins = []) {
  const tag = cspMetaTag(html, relayOrigins);
  const existing = /<meta http-equiv="Content-Security-Policy"[^>]*>/;
  if (existing.test(html)) return html.replace(existing, tag);
  return html.replace(/(<meta charset="UTF-8">\n)/, `$1  ${tag}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const relayOrigins = extraConnectOrigins();
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const next = applyCspMeta(html, relayOrigins);
  if (next !== html) fs.writeFileSync(INDEX_HTML, next);
  fs.writeFileSync(HEADERS_FILE, staticHeadersFile(next, relayOrigins));
  console.log(`CSP written to index.html and _headers${relayOrigins.length ? ` (connect-src: ${relayOrigins.join(', ')})` : ''}`);
}
