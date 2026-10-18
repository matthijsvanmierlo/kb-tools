import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * Evaluate sw.js the way a browser does (classic script, importScripts) inside a sandbox and
 * return what it exposes on `self.KB_SW`. Throws on syntax a classic worker can't run (e.g. `export`).
 */
export function loadServiceWorker(origin = 'http://localhost:8000') {
  const root = process.cwd();
  const listeners = {};
  const self = {
    location: new URL(`${origin}/sw.js`),
    registration: { scope: `${origin}/` },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} }
  };
  const context = vm.createContext({
    self,
    URL,
    Response: globalThis.Response,
    caches: {},
    fetch: () => Promise.reject(new Error('offline')),
    importScripts: (...files) => {
      for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), context, { filename: f });
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), context, { filename: 'sw.js' });
  return { ...self.KB_SW, self, listeners };
}
