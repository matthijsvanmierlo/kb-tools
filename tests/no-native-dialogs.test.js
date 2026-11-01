import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function walk(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walk(full));
    } else if (entry.isFile() && full.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

describe('No native dialogs in src/', () => {
  it('should not contain any direct calls to window.alert, window.confirm, or window.prompt', () => {
    const srcDir = path.resolve(__dirname, '../src');
    const files = walk(srcDir);
    const offenders = [];

    // Regex matching alert(...), confirm(...), prompt(...) not preceded by a dot (unless window.)
    // and excluding method definitions like confirm: () => or static confirm(
    const pattern = /(?:window\.)?\b(alert|confirm|prompt)\s*\(/g;

    for (const file of files) {
      // Skip dialogs.js itself where AlertDialog / ConfirmDialog / PromptDialog wrappers live
      if (file.endsWith('dialogs.js')) continue;

      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        // Skip comment lines
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

        let match;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(line)) !== null) {
          const matchIdx = match.index;
          // check if preceded by something like `.confirm(` or `ConfirmDialog.confirm`
          if (matchIdx > 0 && line[matchIdx - 1] === '.' && !line.slice(0, matchIdx).endsWith('window.')) {
            continue;
          }
          offenders.push(`${path.relative(srcDir, file)}:${i + 1} -> ${trimmed}`);
        }
      }
    }

    expect(offenders, `Found native dialog calls in:\n${offenders.join('\n')}`).toEqual([]);
  });
});
