import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCsp, importMapHash, extraConnectOrigins, INDEX_HTML } from './scripts/csp.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8000;

// Optional cross-origin school relay(s) and cloud backup providers, e.g.
// KB_RELAY_ORIGIN=https://relay.myschool.edu KB_CLOUD_PROVIDERS=google,microsoft
const RELAY_ORIGINS = extraConnectOrigins();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.kbr': 'application/octet-stream',
  '.kbshare': 'application/json'
};

// Never serve source-control metadata, dependencies or server-side code
const BLOCKED_TOP_LEVEL = new Set(['node_modules', 'server', 'scripts', 'tests']);

function securityHeaders() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  return {
    'Content-Security-Policy': buildCsp({ importMapHash: importMapHash(html), relayOrigins: RELAY_ORIGINS, header: true }),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY'
  };
}

/**
 * Map a request URL to a file inside the project root, or null when it must not be served.
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function resolveRequestPath(rawUrl, rootDir = __dirname) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const resolved = path.resolve(rootDir, '.' + path.posix.normalize(pathname));
  const rel = path.relative(rootDir, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const segments = rel.split(path.sep);
  if (segments.some(s => s.startsWith('.'))) return null;
  if (BLOCKED_TOP_LEVEL.has(segments[0])) return null;
  return resolved;
}

/**
 * Serve the static app with security headers. Exported so the relay can serve the app on its own
 * origin (KB_RELAY_SERVE_APP=1), e.g. on a school LAN server.
 */
export function appHandler(req, res) {
  const headers = securityHeaders();

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
    res.end('405 Method Not Allowed');
    return;
  }

  if (req.url.split('?')[0] === '/favicon.ico') {
    res.writeHead(301, { ...headers, Location: '/icons/icon.svg' });
    res.end();
    return;
  }

  const filePath = resolveRequestPath(req.url);
  if (!filePath) {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      const notFound = err.code === 'ENOENT' || err.code === 'EISDIR';
      res.writeHead(notFound ? 404 : 500, { ...headers, 'Content-Type': 'text/plain' });
      res.end(notFound ? '404 Not Found' : '500 Internal Server Error');
      return;
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

const server = http.createServer(appHandler);

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  server.listen(PORT, () => {
    console.log(`\n🚀 KennisBoost Tools is running locally at:`);
    console.log(`   👉 http://localhost:${PORT}\n`);
    if (RELAY_ORIGINS.length) console.log(`   Relay origins allowed by CSP: ${RELAY_ORIGINS.join(', ')}`);
    console.log(`Press Ctrl+C to stop the server.`);
  });
}
