import {
  basicSetup,
  EditorView,
  EditorState,
  Compartment,
  Decoration,
  GutterMarker,
  gutter,
  lineNumbers,
  python,
  javascript,
  java,
  cpp,
  html,
  css,
  sql,
  oneDark
} from 'codemirror';
import { Sanitizer } from '../core/sanitizer.js';

export const LANGUAGE_MAP = {
  python: 'python',
  py: 'python',
  javascript: 'javascript',
  js: 'javascript',
  typescript: 'javascript',
  ts: 'javascript',
  java: 'java',
  cpp: 'cpp',
  'c++': 'cpp',
  c: 'cpp',
  html: 'html',
  htm: 'html',
  css: 'css',
  sql: 'sql',
  plain: 'plain',
  text: 'plain',
  txt: 'plain'
};

export function getLanguageExtension(lang) {
  const normalized = String(lang || 'plain').toLowerCase().trim();
  const mapped = LANGUAGE_MAP[normalized] || normalized;
  switch (mapped) {
    case 'python': return python();
    case 'javascript': return javascript();
    case 'java': return java();
    case 'cpp': return cpp();
    case 'html': return html();
    case 'css': return css();
    case 'sql': return sql();
    default: return [];
  }
}

function isDarkMode() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('sl-theme-dark');
}

const baseTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    border: '1px solid #e2e8f0',
    borderRadius: '0.5rem',
    height: '100%',
    minHeight: '200px'
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'inherit'
  },
  '&.cm-focused': {
    outline: 'none',
    borderColor: '#3b82f6'
  },
  '.cm-gutters': {
    backgroundColor: '#f8fafc',
    color: '#94a3b8',
    borderRight: '1px solid #e2e8f0'
  },
  '.kb-comment-gutter': {
    width: '28px',
    backgroundColor: '#f1f5f9'
  },
  '.kb-comment-marker': {
    cursor: 'pointer',
    textAlign: 'center',
    fontSize: '12px'
  },
  '.kb-line-commented': {
    backgroundColor: '#fef3c7 !important' // amber-100 highlight
  }
});

class CommentGutterMarker extends GutterMarker {
  constructor(count) {
    super();
    this.count = count;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'kb-comment-marker';
    el.innerHTML = `<span title="${this.count} comment(s)">💬</span>`;
    return el;
  }
}

/**
 * Creates an interactive CodeMirror 6 code editor.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} [opts.value='']
 * @param {string} [opts.language='python']
 * @param {boolean} [opts.readOnly=false]
 * @param {function} [opts.onChange]
 * @returns {object} editor controls
 */
export function createCodeEditor(container, {
  value = '',
  language = 'python',
  readOnly = false,
  onChange = null
} = {}) {
  const languageCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const themeCompartment = new Compartment();

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && typeof onChange === 'function') {
      onChange(update.state.doc.toString());
    }
  });

  const extensions = [
    basicSetup,
    baseTheme,
    updateListener,
    languageCompartment.of(getLanguageExtension(language)),
    readOnlyCompartment.of(EditorState.readOnly.of(Boolean(readOnly))),
    themeCompartment.of(isDarkMode() ? oneDark : [])
  ];

  const state = EditorState.create({
    doc: String(value ?? ''),
    extensions
  });

  const view = new EditorView({
    state,
    parent: container
  });

  // Watch for dark theme toggles
  let observer = null;
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      view.dispatch({
        effects: themeCompartment.reconfigure(isDarkMode() ? oneDark : [])
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (newVal) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: String(newVal ?? '') }
      });
    },
    setLanguage: (newLang) => {
      view.dispatch({
        effects: languageCompartment.reconfigure(getLanguageExtension(newLang))
      });
    },
    setReadOnly: (ro) => {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(Boolean(ro)))
      });
    },
    destroy: () => {
      if (observer) observer.disconnect();
      view.destroy();
    }
  };
}

/**
 * Creates a read-only CodeMirror 6 code viewer with inline comment gutter and click handling.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} [opts.value='']
 * @param {string} [opts.language='python']
 * @param {Array<object>|object} [opts.comments=[]] - [{ line, text, ... }] or { [line]: [...] }
 * @param {function} [opts.onLineClick] - (lineNumber) => void
 * @returns {object} viewer controls
 */
export function createCodeViewer(container, {
  value = '',
  language = 'python',
  comments = [],
  onLineClick = null
} = {}) {
  const languageCompartment = new Compartment();
  const themeCompartment = new Compartment();

  // Normalize comments to map: line (1-based number) -> count
  const commentCounts = new Map();
  const rawList = Array.isArray(comments)
    ? comments
    : Object.entries(comments || {}).flatMap(([l, arr]) => (Array.isArray(arr) ? arr.map(c => ({ ...c, line: Number(l) })) : []));

  for (const c of rawList) {
    const l = Number(c.line);
    if (l > 0) {
      commentCounts.set(l, (commentCounts.get(l) || 0) + 1);
    }
  }

  const commentGutter = gutter({
    class: 'kb-comment-gutter',
    lineMarker: (view, line) => {
      const lineNo = view.state.doc.lineAt(line.from).number;
      const count = commentCounts.get(lineNo);
      return count ? new CommentGutterMarker(count) : null;
    },
    domEventHandlers: {
      click: (view, line) => {
        const lineNo = view.state.doc.lineAt(line.from).number;
        if (typeof onLineClick === 'function') {
          onLineClick(lineNo);
        }
        return true;
      }
    }
  });

  const domClickPlugin = EditorView.domEventHandlers({
    click: (event, view) => {
      if (typeof onLineClick !== 'function') return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos !== null) {
        const line = view.state.doc.lineAt(pos).number;
        onLineClick(line);
      }
      return false;
    }
  });

  // Highlight lines that have comments
  const lineHighlightExtension = EditorView.decorations.compute(['doc'], (state) => {
    const builder = [];
    for (const [lineNo] of commentCounts) {
      if (lineNo <= state.doc.lines) {
        const line = state.doc.line(lineNo);
        builder.push(Decoration.line({ class: 'kb-line-commented' }).range(line.from));
      }
    }
    builder.sort((a, b) => a.from - b.from);
    return Decoration.set(builder);
  });

  const extensions = [
    lineNumbers(),
    commentGutter,
    baseTheme,
    domClickPlugin,
    lineHighlightExtension,
    EditorState.readOnly.of(true),
    languageCompartment.of(getLanguageExtension(language)),
    themeCompartment.of(isDarkMode() ? oneDark : [])
  ];

  const state = EditorState.create({
    doc: String(value ?? ''),
    extensions
  });

  const view = new EditorView({
    state,
    parent: container
  });

  let observer = null;
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      view.dispatch({
        effects: themeCompartment.reconfigure(isDarkMode() ? oneDark : [])
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  return {
    view,
    getValue: () => view.state.doc.toString(),
    destroy: () => {
      if (observer) observer.disconnect();
      view.destroy();
    }
  };
}

/**
 * Pure HTML renderer for code files with interleaved line comments.
 * Escapes hostile input; safe for PDFs, student feedback views, and test suites.
 *
 * @param {object} file - { filename, language, body }
 * @param {Array<object>|object} [comments=[]] - comments on lines
 * @returns {string} Sanitized HTML string
 */
export function renderCodeWithComments(file, comments = []) {
  const fileObj = typeof file === 'string' ? { body: file } : (file || {});
  const body = String(fileObj.body ?? '');
  const lines = body.split('\n');
  const filename = fileObj.filename || 'code';
  const language = fileObj.language || 'plain';

  // Group comments by 1-based line number
  const commentList = Array.isArray(comments)
    ? comments
    : Object.entries(comments || {}).flatMap(([l, arr]) => (Array.isArray(arr) ? arr.map(c => ({ ...c, line: Number(l) })) : []));

  const byLine = new Map();
  for (const c of commentList) {
    const l = Number(c.line);
    if (!byLine.has(l)) byLine.set(l, []);
    byLine.get(l).push(c);
  }

  const esc = (s) => Sanitizer.escapeHTML(String(s ?? ''));

  let out = `<div class="kb-code-viewer-pure rounded-xl border border-slate-200 bg-white overflow-hidden my-3 shadow-xs font-mono text-xs">`;
  out += `<div class="bg-slate-100 px-4 py-2 border-b border-slate-200 flex items-center justify-between font-sans">`;
  out += `<span class="font-semibold text-slate-800 flex items-center gap-2">📄 ${esc(filename)}</span>`;
  out += `<span class="text-xs text-slate-500 uppercase tracking-wider">${esc(language)}</span>`;
  out += `</div>`;

  out += `<div class="overflow-x-auto divide-y divide-slate-50">`;

  lines.forEach((lineText, idx) => {
    const lineNum = idx + 1;
    const lineComments = byLine.get(lineNum) || [];
    const hasComments = lineComments.length > 0;

    out += `<div class="flex items-start hover:bg-slate-50/70 ${hasComments ? 'bg-amber-50/60' : ''}">`;
    out += `<div class="w-12 py-1 px-2 text-right text-slate-400 select-none border-r border-slate-100 flex-shrink-0">${lineNum}</div>`;
    out += `<div class="w-8 py-1 text-center select-none flex-shrink-0">${hasComments ? '💬' : ''}</div>`;
    out += `<pre class="flex-1 py-1 px-3 m-0 overflow-x-auto whitespace-pre font-mono text-slate-800"><code>${esc(lineText)}</code></pre>`;
    out += `</div>`;

    if (hasComments) {
      out += `<div class="bg-amber-50/80 border-y border-amber-200/80 pl-20 pr-4 py-2.5 space-y-2 font-sans">`;
      for (const comm of lineComments) {
        out += `<div class="p-2.5 rounded-lg bg-white border border-amber-200 text-slate-800 shadow-xs space-y-1">`;
        out += `<div class="flex items-center justify-between text-[11px] text-slate-500">`;
        out += `<span class="font-semibold text-amber-900">${esc(comm.author || 'Teacher')}</span>`;
        if (comm.created_at) {
          out += `<span>${esc(new Date(comm.created_at).toLocaleDateString())}</span>`;
        }
        out += `</div>`;
        out += `<div class="text-xs text-slate-700 whitespace-pre-wrap">${esc(comm.text ?? comm.comment ?? comm.body ?? '')}</div>`;
        out += `</div>`;
      }
      out += `</div>`;
    }
  });

  out += `</div></div>`;
  return out;
}
