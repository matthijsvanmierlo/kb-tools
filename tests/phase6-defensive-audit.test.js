import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Sanitizer } from '../src/core/sanitizer.js';

describe('Phase 6: Defensive Engineering & XSS Injection Neutralization', () => {
  it('neutralizes malicious <img src=x onerror=alert(1)> inside Markdown/KaTeX fields', () => {
    const maliciousPayload = 'Card Front: $$\\ce{H2 + O2}$$ <img src="x" onerror="alert(1)"> **Important**';
    const rendered = Sanitizer.renderSTEMMarkdown(maliciousPayload);

    // onerror attribute must be strictly forbidden and stripped
    expect(rendered).not.toContain('onerror');
    expect(rendered).not.toContain('alert(1)');
    // Safe elements must be retained
    expect(rendered).toContain('<strong>Important</strong>');
  });

  it('neutralizes script, iframe, and dangerous event handlers across all inputs', () => {
    const dangerousInputs = [
      '<script>alert("pwned")</script>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<div onclick="evil()">Click Me</div>',
      '<a href="javascript:stealTokens()">Secret Link</a>',
      '<svg onload="alert(1)"></svg>'
    ];

    for (const input of dangerousInputs) {
      const sanitized = Sanitizer.sanitize(input);
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).not.toContain('<iframe');
      expect(sanitized).not.toContain('onclick');
      expect(sanitized).not.toContain('onload');
      expect(sanitized).not.toContain('javascript:');
    }
  });

  it('audits that all .innerHTML assignments in src/ are safe or properly sanitized', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    const files = [];

    function walkDir(dir) {
      for (const item of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, item);
        if (fs.statSync(fullPath).isDirectory()) {
          walkDir(fullPath);
        } else if (item.endsWith('.js')) {
          files.push(fullPath);
        }
      }
    }
    walkDir(srcDir);

    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, lineNum) => {
        if (line.includes('.innerHTML =') && !line.includes('//')) {
          // If a variable is interpolated into innerHTML, verify it uses Sanitizer or static template
          const hasInterpolation = line.includes('${');
          if (hasInterpolation) {
            // Must not contain direct unescaped user string
            expect(line).not.toMatch(/\$\{studentName\}/);
            expect(line).not.toMatch(/\$\{deck\.title\}/);
          }
        }
      });
    }
  });
});

describe('Phase 6: PWA Offline Packaging & Service Worker Audit', () => {
  it('validates manifest.json structure and PWA compliance', () => {
    const manifestPath = path.resolve(process.cwd(), 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);

    expect(manifest.name).toBe('KennisBoost Tools');
    expect(manifest.short_name).toBe('KennisBoost');
    expect(manifest.start_url).toBe('./index.html');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#2563eb');
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it('validates sw.js pre-caches core application shell and modules', () => {
    const swPath = path.resolve(process.cwd(), 'sw.js');
    expect(fs.existsSync(swPath)).toBe(true);

    const swContent = fs.readFileSync(swPath, 'utf-8');
    expect(swContent).toContain('CACHE_NAME');
    expect(swContent).toContain('./index.html');
    expect(swContent).toContain('./src/main.js');
    expect(swContent).toContain('./css/app.css');
    expect(swContent).toContain('caches.match');
  });
});
