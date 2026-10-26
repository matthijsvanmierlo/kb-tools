import * as markedModule from 'marked';
import * as dompurifyModule from 'dompurify';

/**
 * Sanitizer - Defensive Engineering & STEM Rendering Pipeline
 * Implements 3-stage deterministic rendering:
 * 1. Tokenize Math & Mhchem delimiters
 * 2. Render KaTeX + Mhchem
 * 3. Markdown parse & strict DOMPurify sanitization
 *
 * Also provides the escaping helpers every innerHTML template must use for data that can come
 * from another person (shared links, student submissions, imports, backups).
 */

// Markdown output + KaTeX output (HTML spans, MathML, and the inline SVG KaTeX uses for
// radicals and stretchy arrows). Anything not listed is removed.
const ALLOWED_TAGS = [
  // text & structure
  'p', 'br', 'hr', 'div', 'span', 'blockquote', 'pre', 'code', 'kbd', 'samp', 'sub', 'sup',
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'small', 'abbr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'figure', 'figcaption', 'details', 'summary', 'input',
  // MathML (KaTeX)
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace',
  'mfrac', 'msqrt', 'mroot', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover',
  'mtable', 'mtr', 'mtd', 'mpadded', 'mphantom', 'menclose', 'mstyle', 'merror',
  // SVG (KaTeX)
  'svg', 'path', 'line', 'rect', 'g'
];

const ALLOWED_ATTR = [
  'class', 'id', 'title', 'lang', 'dir', 'role', 'aria-hidden', 'aria-label',
  'href', 'src', 'alt', 'width', 'height', 'colspan', 'rowspan', 'align', 'start',
  'type', 'checked', 'disabled', 'open', 'target', 'rel',
  // KaTeX lays out with inline styles; DOMPurify still strips url()/expression payloads
  'style',
  // MathML / SVG presentation
  'mathvariant', 'encoding', 'display', 'displaystyle', 'scriptlevel', 'stretchy', 'fence',
  'separator', 'lspace', 'rspace', 'accent', 'accentunder', 'columnalign', 'rowspacing',
  'columnspacing', 'notation', 'linethickness', 'minsize', 'maxsize', 'movablelimits',
  'xmlns', 'viewBox', 'preserveAspectRatio', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'fill',
  'stroke', 'stroke-width', 'transform'
];

// http(s), mailto, in-app hash routes, relative paths, and inline raster images only
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|#|\/(?!\/)|\.{0,2}\/|data:image\/(?:png|gif|jpe?g|webp);base64,|blob:)/i;

export const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'foreignObject', 'use', 'animate', 'set', 'image'],
  FORBID_ATTR: ['srcset', 'action', 'formaction', 'xlink:href', 'ping']
};

const CSS_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Classes untrusted markup may carry: KaTeX's own and markdown's. App utility classes (e.g.
// `fixed inset-0 z-50`) are dropped so shared content cannot overlay the UI with a fake prompt.
const ALLOWED_CLASS_RE = new RegExp('^(?:' + [
  'katex(?:-[a-z]+)*', 'm(?:ord|op|bin|rel|open|close|punct|inner|space|tight|supsub|frac|table|enclose)',
  'base', 'strut', 'vlist(?:-[a-z0-9]+)?', 'pstrut', 'sizing', 'reset-size\\d+', 'size\\d+',
  'fontsize-ensurer', 'delim(?:sizing|center|-size\\d)', 'nulldelimiter', 'sqrt', 'hide-tail',
  'svg-align', 'accent(?:-body|-full)?', 'overline(?:-line)?', 'underline(?:-line)?', 'frac-line',
  'col-align-[lcr]', 'arraycolsep', 'h(?:dash)?line', 'boxpad', 'f(?:color)?box', 'cancel(?:-pad|-lap)?',
  '[bx]?cancel', 'sout', 'stretchy', 'x-arrow(?:-pad)?', 'brace-(?:left|center|right)',
  'halfarrow-(?:left|right)', 'op-(?:symbol|limits)', '(?:large|small)-op', 'tag', 'eqn-num',
  'newline', 'rule', 'root', 'inner', 'fix', 'mult', 'amsrm', 'mainrm', 'boldsymbol', 'smash',
  'math[a-z]+', 'text(?:rm|it|bf|sf|tt|up|md|normal)', 'mspace', 'llap', 'rlap', 'clap', 'thinbox',
  'katex-fallback', 'language-[a-z0-9_+-]+', 'task-list-item(?:-checkbox)?', 'contains-task-list'
].join('|') + ')$', 'i');

// Inline style properties KaTeX emits. Positioning beyond `relative` is never allowed.
const ALLOWED_STYLE_PROPS = new Set([
  'height', 'width', 'min-width', 'max-width', 'vertical-align', 'top', 'bottom', 'left', 'right',
  'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
  'border-bottom-width', 'border-top-width', 'border-right-width', 'border-left-width',
  'border-style', 'border-width', 'border-color', 'color', 'background-color', 'font-size',
  'line-height', 'text-align', 'display', 'position'
]);

export function filterClassList(value) {
  return String(value || '').split(/\s+/).filter(c => c && ALLOWED_CLASS_RE.test(c)).join(' ');
}

export function filterInlineStyle(value) {
  return String(value || '').split(';').map(decl => {
    const idx = decl.indexOf(':');
    if (idx === -1) return '';
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop)) return '';
    if (/url\s*\(|expression\s*\(|javascript:|@import|\\/i.test(val)) return '';
    if (prop === 'position' && val.toLowerCase() !== 'relative') return '';
    if (prop === 'display' && !/^(inline-block|inline|block|table|table-cell|inline-table)$/i.test(val)) return '';
    return `${prop}:${val}`;
  }).filter(Boolean).join(';');
}

export class Sanitizer {
  static getPurify() {
    if (this._purify) return this._purify;

    let purify = dompurifyModule.default || dompurifyModule;
    if (typeof purify.sanitize !== 'function' && typeof window !== 'undefined') {
      purify = purify(window);
    }
    if (purify && typeof purify.addHook === 'function' && !purify.__kbHooked) {
      // External links open in a new tab without leaking the opener or the referrer
      purify.addHook('uponSanitizeAttribute', (node, data) => {
        if (data.attrName === 'class') {
          data.attrValue = filterClassList(data.attrValue);
          if (!data.attrValue) data.keepAttr = false;
        } else if (data.attrName === 'style') {
          data.attrValue = filterInlineStyle(data.attrValue);
          if (!data.attrValue) data.keepAttr = false;
        } else if (data.attrName === 'id') {
          // Prevent DOM clobbering of the app's own element ids
          data.attrValue = `kb-user-${data.attrValue}`;
        }
      });
      purify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A' && node.hasAttribute('href')) {
          const href = node.getAttribute('href') || '';
          if (/^https?:/i.test(href)) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          } else {
            node.removeAttribute('target');
          }
        }
        // Markdown task lists are the only legitimate <input>; keep them inert
        if (node.tagName === 'INPUT') {
          if ((node.getAttribute('type') || '').toLowerCase() !== 'checkbox') node.remove();
          else node.setAttribute('disabled', '');
        }
      });
      purify.__kbHooked = true;
    }
    this._purify = purify;
    return this._purify;
  }

  static getMarked() {
    return markedModule.marked || markedModule.parse || markedModule.default || markedModule;
  }

  /**
   * Escape a value for an HTML text node or a double/single-quoted attribute.
   * Non-strings are stringified (numbers, booleans); null/undefined become ''.
   */
  static escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  static escapeHTML(str) {
    return this.escapeHtml(str);
  }

  /** A finite number for templates (scores, points, counts); anything else becomes `fallback` */
  static safeNumber(value, fallback = 0) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /** A hex CSS color, or `fallback` — use for every color that lands in a style/attribute */
  static safeColor(value, fallback = '#64748b') {
    return typeof value === 'string' && CSS_COLOR_RE.test(value.trim()) ? value.trim() : fallback;
  }

  /**
   * A URL that is safe to put in href/src: http(s), mailto, or an in-app hash route.
   * Returns '' for javascript:, data:, vbscript: and anything unparseable.
   */
  static safeUrl(value, { allowMailto = true } = {}) {
    const url = String(value ?? '').trim();
    if (!url) return '';
    if (url.startsWith('#')) return url;
    if (allowMailto && /^mailto:/i.test(url)) return url;
    try {
      const u = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
    } catch (_) {
      return '';
    }
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
          trust: false,
          maxSize: 50,
          maxExpand: 500
        });
      } catch (err) {
        console.warn('KaTeX render error:', err);
      }
    }
    // Fallback if KaTeX is not loaded
    const tag = displayMode ? 'div' : 'span';
    return `<${tag} class="katex-fallback">${this.escapeHtml(expr)}</${tag}>`;
  }

  /**
   * Complete 3-stage rendering pipeline for STEM markdown
   * @param {string} rawInput
   * @returns {string} Sanitized HTML string
   */
  static renderSTEMMarkdown(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return '';

    // Stage 0: Protect fenced code blocks and inline code from math extraction
    const codeTokens = [];
    let codeIndex = 0;

    let tokenized = rawInput.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (match) => {
      const placeholder = `@@KB_CODE_BLOCK_${codeIndex++}@@`;
      codeTokens.push({ placeholder, text: match });
      return placeholder;
    });

    tokenized = tokenized.replace(/(`+)([\s\S]*?)\1/g, (match) => {
      const placeholder = `@@KB_CODE_SPAN_${codeIndex++}@@`;
      codeTokens.push({ placeholder, text: match });
      return placeholder;
    });

    const mathTokens = [];
    let tokenIndex = 0;

    // Stage 1: Tokenize block math $$...$$ and inline math $...$
    // Block math: $$ ... $$
    tokenized = tokenized.replace(/\$\$([\s\S]+?)\$\$/g, (match, expr) => {
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

    // Restore protected code blocks before passing to markdown parser
    for (const token of codeTokens) {
      tokenized = tokenized.replace(token.placeholder, () => token.text);
    }

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
      // No markdown engine: treat the input as plain text
      parsedHtml = this.escapeHtml(tokenized).replace(/\n/g, '<br>');
    }

    // Restore rendered math placeholders
    for (const [placeholder, katexHtml] of renderedMath.entries()) {
      // Use replace with a function to prevent replacement patterns like $& or $1 in math
      parsedHtml = parsedHtml.replace(placeholder, () => katexHtml);
    }

    return this.sanitize(parsedHtml);
  }

  /**
   * Sanitize an HTML string directly. Fails closed: without DOMPurify the input is escaped.
   */
  static sanitize(html) {
    if (!html || typeof html !== 'string') return '';
    const purify = this.getPurify();
    if (purify && typeof purify.sanitize === 'function') {
      return purify.sanitize(html, PURIFY_CONFIG);
    }
    return this.escapeHtml(html);
  }
}

export const renderSTEMMarkdown = (raw) => Sanitizer.renderSTEMMarkdown(raw);
export default Sanitizer;
