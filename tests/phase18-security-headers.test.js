import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildCsp, importMapHash, cspMetaTag, staticHeadersFile } from '../scripts/csp.mjs';
import { resolveRequestPath } from '../server.js';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const sourceFiles = walk(path.join(root, 'src')).filter(f => f.endsWith('.js'));

function directive(csp, name) {
  const part = csp.split(';').map(s => s.trim()).find(s => s.startsWith(`${name} `));
  return part ? part.slice(name.length + 1).split(' ') : null;
}

describe('Phase 18: Content Security Policy & security headers (rev-3 §2.1)', () => {
  const metaCsp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];

  it('ships a CSP meta tag that matches the generator (run `npm run csp` after editing the import map)', () => {
    expect(metaCsp).toBeTruthy();
    expect(html).toContain(cspMetaTag(html));
  });

  it('pins the inline import map by hash and allows no inline script or eval', () => {
    const scriptSrc = directive(metaCsp, 'script-src');
    expect(scriptSrc).toEqual(["'self'", importMapHash(html)]);
    expect(metaCsp).not.toContain('unsafe-eval');
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('cannot send data to third-party origins', () => {
    expect(directive(metaCsp, 'connect-src')).toEqual(["'self'", 'data:']);
    expect(directive(metaCsp, 'default-src')).toEqual(["'self'"]);
    expect(directive(metaCsp, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(directive(metaCsp, 'object-src')).toEqual(["'none'"]);
    expect(directive(metaCsp, 'base-uri')).toEqual(["'none'"]);
    expect(directive(metaCsp, 'form-action')).toEqual(["'none'"]);
  });

  it('only frames the privacy-enhanced YouTube host and the Vimeo player', () => {
    expect(directive(metaCsp, 'frame-src')).toEqual(['https://www.youtube-nocookie.com', 'https://player.vimeo.com']);
  });

  it('adds frame-ancestors only in header form, and lists extra relay origins on request', () => {
    expect(directive(metaCsp, 'frame-ancestors')).toBeNull();
    const header = buildCsp({ importMapHash: importMapHash(html), header: true, relayOrigins: ['https://relay.school.edu'] });
    expect(directive(header, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(header, 'connect-src')).toContain('https://relay.school.edu');
  });

  it('keeps the static-host _headers file in sync', () => {
    expect(fs.readFileSync(path.join(root, '_headers'), 'utf8')).toBe(staticHeadersFile(html));
  });

  it('sends no Referer and loads every script, style and font from this origin', () => {
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
    expect(external).toEqual([]);
    const importMap = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
    for (const target of Object.values(importMap.imports)) {
      expect(target).toMatch(/^\.\/vendor\/[\w-]+\.mjs$/);
      expect(fs.existsSync(path.join(root, target))).toBe(true);
    }
  });

  it('has no inline scripts other than the import map, and no inline event handlers', () => {
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map(m => m[1].trim());
    expect(inline).toEqual(['type="importmap"']);
    const handlerAttr = /\son[a-z]+\s*=\s*["']/i;
    expect(handlerAttr.test(html)).toBe(false);
    for (const f of sourceFiles) {
      const src = fs.readFileSync(f, 'utf8');
      // HTML strings inside JS: `<tag ... onclick="...">`
      expect(/<[a-z][^>`]*\son(?:click|error|load|change|input|submit|keydown|mouseover)\s*=\s*["']/i.test(src), f).toBe(false);
    }
  });

  it('never injects third-party scripts or uses eval at runtime', () => {
    for (const f of sourceFiles) {
      const src = fs.readFileSync(f, 'utf8');
      expect(/\.src\s*=\s*['"`]https?:/.test(src), `${f} loads a remote script`).toBe(false);
      expect(/\bnew Function\s*\(|\beval\s*\(/.test(src), `${f} uses eval`).toBe(false);
    }
  });
});

describe('Phase 18: Local server path resolution', () => {
  it('serves files inside the project', () => {
    expect(resolveRequestPath('/', root)).toBe(path.join(root, 'index.html'));
    expect(resolveRequestPath('/src/main.js?v=1', root)).toBe(path.join(root, 'src/main.js'));
  });

  it('never resolves outside the project root', () => {
    for (const url of ['/../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2f..%2fetc/passwd', '/src/..%5c..%5c..%5cetc']) {
      const resolved = resolveRequestPath(url, root);
      expect(resolved === null || resolved.startsWith(root + path.sep), url).toBe(true);
    }
  });

  it('refuses dotfiles, dependencies, server code and malformed paths', () => {
    for (const url of ['/.git/config', '/.env', '/node_modules/dexie/package.json', '/server/relay/db.js',
      '/scripts/csp.mjs', '/tests/phase1-core.test.js', '/%E0%A4%A', '/src/%00main.js']) {
      expect(resolveRequestPath(url, root), url).toBeNull();
    }
  });
});
