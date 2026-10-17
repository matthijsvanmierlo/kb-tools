import * as markedModule from 'marked';
import * as dompurifyModule from 'dompurify';

/**
 * Sanitizer - Defensive Engineering & STEM Rendering Pipeline
 * Implements 3-stage deterministic rendering:
 * 1. Tokenize Math & Mhchem delimiters
 * 2. Render KaTeX + Mhchem
 * 3. Markdown parse & strict DOMPurify sanitization
 */
export class Sanitizer {
  static getPurify() {
    if (this._purify) return this._purify;

    let purify = dompurifyModule.default || dompurifyModule;
    if (typeof purify.sanitize !== 'function' && typeof window !== 'undefined') {
      purify = purify(window);
    }
    this._purify = purify;
    return this._purify;
  }

  static getMarked() {
    return markedModule.marked || markedModule.parse || markedModule.default || markedModule;
  }

  /**
   * Escape raw HTML characters defensively
   */
  static escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Render KaTeX expression safely
   * @param {string} expr
   * @param {boolean} displayMode
   * @returns {string} HTML string
   */
  static renderKaTeXExpression(expr, displayMode = false) {
    const katex = typeof window !== 'undefined' ? window.katex : (typeof globalThis !== 'undefined' ? globalThis.katex : null);
    if (katex && typeof katex.renderToString === 'function') {
      try {
        return katex.renderToString(expr, {
          displayMode,
          throwOnError: false,
          trust: false
        });
      } catch (err) {
        console.warn('KaTeX render error:', err);
      }
    }
    // Fallback if KaTeX is not loaded
    const tag = displayMode ? 'div' : 'span';
    return `<${tag} class="katex-fallback" data-raw="${this.escapeHtml(expr)}">${this.escapeHtml(expr)}</${tag}>`;
  }

  /**
   * Complete 3-stage rendering pipeline for STEM markdown
   * @param {string} rawInput
   * @returns {string} Sanitized HTML string
   */
  static renderSTEMMarkdown(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return '';

    const mathTokens = [];
    let tokenIndex = 0;

    // Stage 1: Tokenize block math $$...$$ and inline math $...$
    // Block math: $$ ... $$
    let tokenized = rawInput.replace(/\$\$([\s\S]+?)\$\$/g, (match, expr) => {
      const placeholder = `@@KB_MATH_BLOCK_${tokenIndex++}@@`;
      mathTokens.push({ placeholder, expr: expr.trim(), displayMode: true });
      return placeholder;
    });

    // Inline math: $ ... $ (excluding newline, not escaped)
    tokenized = tokenized.replace(/(?<!\\)\$([^\$\n]+?)(?<!\\)\$/g, (match, expr) => {
      const placeholder = `@@KB_MATH_INLINE_${tokenIndex++}@@`;
      mathTokens.push({ placeholder, expr: expr.trim(), displayMode: false });
      return placeholder;
    });

    // Stage 2: Render math tokens into KaTeX HTML
    const renderedMath = new Map();
    for (const token of mathTokens) {
      renderedMath.set(token.placeholder, this.renderKaTeXExpression(token.expr, token.displayMode));
    }

    // Stage 3: Parse markdown with Marked
    const marked = this.getMarked();
    let parsedHtml = '';
    if (typeof marked.parse === 'function') {
      parsedHtml = marked.parse(tokenized);
    } else if (typeof marked === 'function') {
      parsedHtml = marked(tokenized);
    } else {
      parsedHtml = tokenized;
    }

    // Restore rendered math placeholders
    for (const [placeholder, katexHtml] of renderedMath.entries()) {
      // Use replace with a function to prevent replacement patterns like $& or $1 in math
      parsedHtml = parsedHtml.replace(placeholder, () => katexHtml);
    }

    // Strict DOMPurify Sanitization
    const purify = this.getPurify();
    if (purify && typeof purify.sanitize === 'function') {
      return purify.sanitize(parsedHtml, {
        USE_PROFILES: { html: true, svg: true, mathMl: true },
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
      });
    }

    return parsedHtml;
  }

  /**
   * Sanitize an HTML string directly
   */
  static sanitize(html) {
    if (!html || typeof html !== 'string') return '';
    const purify = this.getPurify();
    if (purify && typeof purify.sanitize === 'function') {
      return purify.sanitize(html, {
        USE_PROFILES: { html: true, svg: true, mathMl: true },
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
      });
    }
    return html;
  }
}

export default Sanitizer;
