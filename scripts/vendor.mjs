#!/usr/bin/env node
/**
 * Self-host every third-party dependency under vendor/ so the app runs under a strict
 * `script-src 'self'` Content Security Policy and works fully offline.
 *
 *   npm run vendor
 *
 * - Each import-map package is bundled by esbuild into a single ES module (vendor/<name>.mjs).
 *   Other import-map packages stay external so they resolve through the import map at runtime.
 * - Shoelace's prebuilt `cdn/` distribution and KaTeX's dist files are copied verbatim.
 *
 * Re-run after upgrading any of these packages, then commit vendor/.
 */
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'vendor');
const nm = (...p) => path.join(root, 'node_modules', ...p);

// Bare specifier → vendor/<file>. Must match the import map in index.html.
export const ESM_PACKAGES = {
  dexie: 'dexie.mjs',
  zod: 'zod.mjs',
  'lz-string': 'lz-string.mjs',
  papaparse: 'papaparse.mjs',
  marked: 'marked.mjs',
  dompurify: 'dompurify.mjs',
  jspdf: 'jspdf.mjs',
  'jspdf-autotable': 'jspdf-autotable.mjs',
  jszip: 'jszip.mjs',
  'qrcode-generator': 'qrcode-generator.mjs',
  codemirror: {
    file: 'codemirror.mjs',
    shim: `
export * from 'codemirror';
export * from '@codemirror/state';
export * from '@codemirror/view';
export { python } from '@codemirror/lang-python';
export { javascript } from '@codemirror/lang-javascript';
export { java } from '@codemirror/lang-java';
export { cpp } from '@codemirror/lang-cpp';
export { html } from '@codemirror/lang-html';
export { css } from '@codemirror/lang-css';
export { sql } from '@codemirror/lang-sql';
export { oneDark } from '@codemirror/theme-one-dark';
`
  }
};

// Optional jsPDF features the app never calls (doc.html(), SVG rendering) — left unresolved.
const OPTIONAL_EXTERNALS = ['html2canvas', 'canvg', 'core-js'];

async function bundlePackages() {
  const names = Object.keys(ESM_PACKAGES);
  for (const name of names) {
    const pkgConfig = ESM_PACKAGES[name];
    const outfile = typeof pkgConfig === 'string' ? pkgConfig : pkgConfig.file;
    const shim = typeof pkgConfig === 'object' && pkgConfig.shim
      ? pkgConfig.shim
      : `export * from '${name}';\nimport * as m from '${name}';\nexport default (m.default ?? m);\n`;

    await build({
      stdin: { contents: shim, resolveDir: root, sourcefile: `${name}-entry.js` },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      minify: true,
      legalComments: 'inline',
      external: [...names.filter(n => n !== name && !n.startsWith('@codemirror')), ...OPTIONAL_EXTERNALS],
      outfile: path.join(vendorDir, outfile),
      logLevel: 'warning',
      // `m.default` is intentionally probed on packages without a default export
      logOverride: { 'import-is-undefined': 'silent' }
    });
  }
}

function copyDir(src, dest, filter = () => true) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (!filter(s, entry)) continue;
    if (entry.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

function copyShoelace() {
  const src = nm('@shoelace-style', 'shoelace', 'cdn');
  const dest = path.join(vendorDir, 'shoelace');
  fs.rmSync(dest, { recursive: true, force: true });
  const keep = ['assets', 'chunks', 'components', 'events', 'internal', 'styles', 'themes', 'translations', 'utilities', 'shoelace-autoloader.js', 'shoelace.js'];
  fs.mkdirSync(dest, { recursive: true });
  for (const item of keep) {
    const s = path.join(src, item);
    const d = path.join(dest, item);
    if (fs.statSync(s).isDirectory()) copyDir(s, d, (p) => !p.endsWith('.d.ts') && !p.endsWith('.map'));
    else fs.copyFileSync(s, d);
  }
}

function copyKatex() {
  const src = nm('katex', 'dist');
  const dest = path.join(vendorDir, 'katex');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'contrib'), { recursive: true });
  fs.copyFileSync(path.join(src, 'katex.min.js'), path.join(dest, 'katex.min.js'));
  fs.copyFileSync(path.join(src, 'katex.min.css'), path.join(dest, 'katex.min.css'));
  fs.copyFileSync(path.join(src, 'contrib', 'mhchem.min.js'), path.join(dest, 'contrib', 'mhchem.min.js'));
  // woff2 is supported by every browser the app targets; skip the legacy formats
  copyDir(path.join(src, 'fonts'), path.join(dest, 'fonts'), (p, e) => e.isDirectory() || p.endsWith('.woff2'));
}

function copyClassicScripts() {
  // jsQR is only loaded on demand by the QR scanner when BarcodeDetector is unavailable
  fs.copyFileSync(nm('jsqr', 'dist', 'jsQR.js'), path.join(vendorDir, 'jsQR.js'));
}

function writeVersions() {
  const pkgs = [...Object.keys(ESM_PACKAGES), '@shoelace-style/shoelace', 'katex', 'jsqr'];
  const versions = {};
  for (const p of pkgs) {
    versions[p] = JSON.parse(fs.readFileSync(nm(...p.split('/'), 'package.json'), 'utf8')).version;
  }
  fs.writeFileSync(path.join(vendorDir, 'VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
}

fs.mkdirSync(vendorDir, { recursive: true });
await bundlePackages();
copyShoelace();
copyKatex();
copyClassicScripts();
writeVersions();
console.log('Vendored dependencies written to vendor/');
