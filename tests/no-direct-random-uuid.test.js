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

describe('No direct crypto.randomUUID() outside src/utils/uuid.js', () => {
  it('should not contain any direct calls to crypto.randomUUID', () => {
    const srcDir = path.resolve(__dirname, '../src');
    const files = walk(srcDir);
    const offenders = [];

    const pattern = /crypto\.randomUUID\s*\(/g;

    for (const file of files) {
      // uuid.js is the only place allowed to call crypto.randomUUID()
      if (file.endsWith('uuid.js')) continue;

      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

        if (pattern.test(line)) {
          offenders.push(`${path.relative(srcDir, file)}:${i + 1} -> ${trimmed}`);
        }
      }
    }

    expect(offenders, `Found direct crypto.randomUUID calls in:\n${offenders.join('\n')}`).toEqual([]);
  });
});
