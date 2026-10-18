import { describe, it, expect, beforeAll } from 'vitest';
import katex from 'katex';
import { Sanitizer, filterClassList, filterInlineStyle } from '../src/core/sanitizer.js';
import { normalizeSharedEnvelope, toLibraryRecord } from '../src/core/shared-payload.js';

const INJECTIONS = [
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)><circle r=1></circle></svg>',
  '<script>alert(1)</script>',
  '[click](javascript:alert(1))',
  '<a href="jAvAsCrIpT:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<iframe src="https://evil.example"></iframe>',
  '<form action="https://evil.example"><input name=code></form>',
  '<details open ontoggle=alert(1)>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<svg><foreignObject><div onclick=alert(1)>x</div></foreignObject></svg>',
  '<svg><use href="data:image/svg+xml,<svg id=x onload=alert(1)>#x"></use></svg>',
  '<style>body{display:none}</style>',
  '<div style="position:fixed;inset:0;background:url(https://evil.example/t.gif)">overlay</div>',
  '<div class="fixed inset-0 z-50 bg-white">Enter your access code</div>',
  '<object data="x.swf"></object><embed src="x.swf">',
  '<img src="https://tracker.example/pixel.gif" srcset="https://tracker.example/2x.gif 2x">',
  '<a href="#" id="app-view-container">clobber</a>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<base href="https://evil.example/">'
];

describe('Phase 19: Sanitizer hardening (rev-3 §2.1)', () => {
  it.each(INJECTIONS)('neutralises %s', (payload) => {
    const out = Sanitizer.renderSTEMMarkdown(payload);
    expect(out).not.toMatch(/<script|<iframe|<object|<embed|<form|<style|<meta|<base|<foreignobject|<use\b/i);
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).not.toMatch(/javascript:|data:text\/html/i);
    expect(out).not.toMatch(/position:\s*fixed|url\(/i);
    expect(out).not.toMatch(/\b(fixed|inset-0|z-50)\b/);
    expect(out).not.toMatch(/id="app-view-container"/);
    expect(out).not.toMatch(/srcset/);
  });

  it('keeps ordinary markdown intact and hardens external links', () => {
    const out = Sanitizer.renderSTEMMarkdown('# Title\n\n**bold** and `code`\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n[site](https://example.org)');
    expect(out).toContain('<h1');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<table>');
    expect(out).toContain('href="https://example.org"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('escapes non-string values instead of dropping them', () => {
    expect(Sanitizer.escapeHtml(42)).toBe('42');
    expect(Sanitizer.escapeHtml(null)).toBe('');
    expect(Sanitizer.escapeHtml('"><img src=x>')).toBe('&quot;&gt;&lt;img src=x&gt;');
  });

  it('provides safe number, color and URL coercion for templates', () => {
    expect(Sanitizer.safeNumber('7')).toBe(7);
    expect(Sanitizer.safeNumber('<b>1</b>', 0)).toBe(0);
    expect(Sanitizer.safeColor('#3b82f6')).toBe('#3b82f6');
    expect(Sanitizer.safeColor('red;" onmouseover="x', '#000')).toBe('#000');
    expect(Sanitizer.safeUrl('javascript:alert(1)')).toBe('');
    expect(Sanitizer.safeUrl('#/share?d=abc')).toBe('#/share?d=abc');
    expect(Sanitizer.safeUrl('https://example.org/a')).toBe('https://example.org/a');
  });

  it('filters classes and inline styles to what KaTeX needs', () => {
    expect(filterClassList('katex mord vlist-t2 fixed inset-0')).toBe('katex mord vlist-t2');
    expect(filterInlineStyle('height:1.2em;position:absolute;vertical-align:-0.25em;background-image:url(x)'))
      .toBe('height:1.2em;vertical-align:-0.25em');
  });

  describe('with KaTeX loaded', () => {
    beforeAll(async () => {
      globalThis.katex = katex;
      window.katex = katex;
      await import('katex/contrib/mhchem');
    });

    it('renders math and chemistry through the sanitizer without losing KaTeX structure', () => {
      const out = Sanitizer.renderSTEMMarkdown('Energy $E = mc^2$ and $$\\ce{H2 + O2 -> H2O}$$ and $\\sqrt{x}$');
      expect(out).toContain('class="katex"');
      expect(out).toContain('<math');
      expect(out).toMatch(/class="[^"]*\bmord\b/);
      expect(out).toMatch(/style="[^"]*height:/);
      expect(out).toContain('<svg');
      expect(out).not.toContain('katex-error');
    });

    it('refuses KaTeX trust features such as \\href to javascript:', () => {
      const out = Sanitizer.renderSTEMMarkdown('$\\href{javascript:alert(1)}{x}$');
      // KaTeX shows the rejected command as text; what matters is that no link is created
      expect(out).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
      expect(out).not.toMatch(/<a\b/i);
    });
  });
});

describe('Phase 19: Shared payload normalisation', () => {
  it('rejects unknown share types and non-object payloads', () => {
    expect(() => normalizeSharedEnvelope({ type: 'evil', payload: {} })).toThrow('UNKNOWN_SHARE_TYPE');
    expect(() => normalizeSharedEnvelope({ type: 'flashcards', payload: 'x' })).toThrow('MISSING_PAYLOAD');
    expect(() => normalizeSharedEnvelope(null)).toThrow();
  });

  it('coerces numbers, colours and enums that templates trust', () => {
    const { payload } = normalizeSharedEnvelope({
      type: 'video',
      payload: {
        provider: 'evil"><script>',
        checkpoints: [{ points: '<img src=x onerror=alert(1)>', timestamp_sec: '12' }],
        score: { earned: '1"><b>', possible: 10 },
        events: [{ color: 'red" onmouseover="x' }],
        title: 'Plain <b>text</b> stays text (escaped at render)'
      }
    });
    expect(payload.provider).toBe('html5');
    expect(payload.checkpoints[0].points).toBe(0);
    expect(payload.checkpoints[0].timestamp_sec).toBe(12);
    expect(payload.score.earned).toBe(0);
    expect(payload.events[0].color).toBe('#64748b');
    expect(payload.title).toContain('<b>');
  });

  it('drops prototype-pollution keys and caps nesting', () => {
    const { payload } = normalizeSharedEnvelope({ type: 'timeline', payload: JSON.parse('{"__proto__":{"polluted":1},"a":1}') });
    expect(({}).polluted).toBeUndefined();
    expect(Object.keys(payload)).toEqual(['a']);
    let deep = {};
    const rootObj = deep;
    for (let i = 0; i < 50; i++) deep = (deep.x = {});
    expect(() => normalizeSharedEnvelope({ type: 'timeline', payload: rootObj })).toThrow('PAYLOAD_TOO_DEEP');
  });

  it('gives library copies a fresh id and no foreign class reference', () => {
    const rec = toLibraryRecord({ id: 'abc', class_id: 'their-class', title: 'Deck' });
    expect(rec.id).not.toBe('abc');
    expect(rec.class_id).toBeNull();
    expect(rec.title).toBe('Deck');
  });
});
