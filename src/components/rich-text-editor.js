import { Sanitizer } from '../core/sanitizer.js';

/**
 * Reusable Rich Text & STEM Editor Component
 * Supports Markdown, KaTeX math notation, Mhchem chemical reactions,
 * quick symbol palette popover, split view, and tabbed compact view.
 */
export class RichTextEditor {
  /**
   * @param {object} options
   * @param {string} [options.initialValue='']
   * @param {string} [options.placeholder='Write in Markdown or LaTeX...']
   * @param {'split'|'tabbed'} [options.mode='split']
   * @param {string} [options.minHeight='140px']
   * @param {string} [options.maxHeight='500px']
   * @param {(val: string) => void} [options.onChange]
   */
  constructor(options = {}) {
    this.value = options.initialValue || '';
    this.placeholder = options.placeholder || 'Write in Markdown or LaTeX ($...$, $$\\ce{...}$$)...';
    this.mode = options.mode || 'split';
    this.minHeight = options.minHeight || '140px';
    this.maxHeight = options.maxHeight || '500px';
    this.onChange = options.onChange || null;

    this.debounceTimer = null;
    this.element = this._buildDOM();
    this.setValue(this.value);
  }

  _buildDOM() {
    const root = document.createElement('div');
    root.className = 'kb-rich-editor border border-slate-200 rounded-xl overflow-hidden bg-white shadow-sm flex flex-col focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500 transition-all';

    // Toolbar Header
    const toolbar = document.createElement('div');
    toolbar.className = 'kb-editor-toolbar bg-slate-50 border-b border-slate-200 px-2 py-1.5 flex flex-wrap items-center justify-between gap-2 text-slate-600 select-none';

    toolbar.innerHTML = `
      <div class="flex items-center flex-wrap gap-1">
        <!-- Formatting -->
        <button type="button" class="kb-icon-btn" data-action="bold" title="Bold (Ctrl+B)" aria-label="Bold"><sl-icon name="type-bold"></sl-icon></button>
        <button type="button" class="kb-icon-btn" data-action="italic" title="Italic (Ctrl+I)" aria-label="Italic"><sl-icon name="type-italic"></sl-icon></button>
        <button type="button" class="kb-icon-btn" data-action="strike" title="Strikethrough" aria-label="Strikethrough"><sl-icon name="type-strikethrough"></sl-icon></button>
        <button type="button" class="kb-icon-btn" data-action="underline" title="Underline" aria-label="Underline"><sl-icon name="type-underline"></sl-icon></button>
        <button type="button" class="kb-icon-btn" data-action="code" title="Inline code" aria-label="Inline code"><sl-icon name="code"></sl-icon></button>
        <button type="button" class="kb-icon-btn" data-action="mark" title="Highlight" aria-label="Highlight"><sl-icon name="highlighter"></sl-icon></button>

        <span class="w-px h-5 bg-slate-200 mx-1" aria-hidden="true"></span>

        <!-- Structure -->
        <button type="button" class="kb-icon-btn" data-action="h3" title="Heading" aria-label="Heading"><sl-icon name="type-h3"></sl-icon></button>
        <button type="button" class="kb-icon-btn" data-action="bullet" title="Bulleted list" aria-label="Bulleted list"><sl-icon name="list-ul"></sl-icon></button>
        <button type="button" class="kb-icon-btn" data-action="number" title="Numbered list" aria-label="Numbered list"><sl-icon name="list-ol"></sl-icon></button>
        <button type="button" class="kb-icon-btn" data-action="quote" title="Quote" aria-label="Quote"><sl-icon name="quote"></sl-icon></button>
        <button type="button" class="kb-icon-btn" data-action="hr" title="Divider" aria-label="Divider"><sl-icon name="hr"></sl-icon></button>
        <button type="button" class="kb-icon-btn" data-action="table" title="Insert table" aria-label="Insert table"><sl-icon name="table"></sl-icon></button>

        <span class="w-px h-5 bg-slate-200 mx-1" aria-hidden="true"></span>

        <!-- STEM Tools -->
        <button type="button" class="kb-icon-btn kb-tool-text text-blue-600 font-serif italic" data-action="math-inline" title="Inline math ($…$, Ctrl+M)" aria-label="Inline math">x²</button>
        <button type="button" class="kb-icon-btn kb-tool-text text-blue-600 font-serif" data-action="math-block" title="Display math ($$…$$)" aria-label="Display math">∫dx</button>
        <button type="button" class="kb-icon-btn kb-tool-text text-emerald-600" data-action="chem" title="Chemistry (\\ce{…})" aria-label="Chemistry formula">H₂O</button>

        <!-- STEM Palette Popover Trigger -->
        <sl-dropdown placement="bottom-start" hoist>
          <button slot="trigger" type="button" class="kb-icon-btn kb-tool-text text-indigo-600 gap-1" title="Symbol palette" aria-label="Symbol palette">
            <span>Ωπ</span>
            <sl-icon name="chevron-down" class="text-[10px]"></sl-icon>
          </button>
          <div class="p-3 bg-white border border-slate-200 shadow-xl rounded-xl w-72 space-y-3 text-xs max-h-80 overflow-y-auto">
            <div>
              <div class="font-semibold text-slate-700 mb-1.5">Math Symbols</div>
              <div class="grid grid-cols-4 gap-1">
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="\\frac{a}{b}">a/b</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="\\sqrt{x}">√x</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="x^{n}">xⁿ</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="x_{i}">xᵢ</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="\\int_{a}^{b}">∫</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="\\sum_{i=1}^{n}">∑</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="\\pi">π</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="\\Delta">Δ</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="\\le">≤</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="\\ge">≥</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="\\neq">≠</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-blue-50 text-slate-800 rounded text-center" data-insert="\\approx">≈</button>
              </div>
            </div>
            <div class="border-t border-slate-100 pt-2">
              <div class="font-semibold text-slate-700 mb-1.5">Chemistry (\\ce)</div>
              <div class="grid grid-cols-3 gap-1">
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-emerald-50 text-slate-800 rounded text-center" data-insert="\\ce{->}">-&gt;</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-emerald-50 text-slate-800 rounded text-center" data-insert="\\ce{<=>}">&lt;=&gt;</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-emerald-50 text-slate-800 rounded text-center" data-insert="\\ce{(aq)}">(aq)</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-emerald-50 text-slate-800 rounded text-center" data-insert="\\ce{(s)}">(s)</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-emerald-50 text-slate-800 rounded text-center" data-insert="\\ce{(g)}">(g)</button>
                <button type="button" class="kb-symbol-btn p-1 bg-slate-50 hover:bg-emerald-50 text-slate-800 rounded text-center" data-insert="\\ce{H2O}">H₂O</button>
              </div>
            </div>
          </div>
        </sl-dropdown>
      </div>

      <!-- Mode / Tab Controls -->
      <div class="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-200/60" role="group" aria-label="Editor layout">
        <button type="button" class="kb-tab-btn px-2.5 py-1 text-xs rounded-md font-medium ${this.mode === 'split' ? 'bg-white shadow-xs text-slate-900 font-semibold' : 'text-slate-500 hover:text-slate-800'}" data-view="split">Split</button>
        <button type="button" class="kb-tab-btn px-2.5 py-1 text-xs rounded-md font-medium ${this.mode === 'tabbed' ? 'bg-white shadow-xs text-slate-900 font-semibold' : 'text-slate-500 hover:text-slate-800'}" data-view="tabbed">Tabbed</button>
      </div>
    `;

    root.appendChild(toolbar);

    // Workspace Container
    const workspace = document.createElement('div');
    workspace.className = 'kb-editor-workspace flex-1 flex flex-col md:flex-row relative';
    workspace.style.minHeight = this.minHeight;
    workspace.style.maxHeight = this.maxHeight;

    // Textarea Input
    const textarea = document.createElement('textarea');
    textarea.className = 'kb-editor-input flex-1 p-3 text-sm text-slate-900 font-mono resize-y border-0 focus:outline-none bg-transparent';
    textarea.placeholder = this.placeholder;
    textarea.style.minHeight = this.minHeight;

    // Tabbed Header (shown only when in tabbed mode)
    const tabNav = document.createElement('div');
    tabNav.className = 'kb-tabbed-subnav flex border-b border-slate-200 bg-slate-100 text-xs px-2 ' + (this.mode === 'tabbed' ? '' : 'hidden');
    tabNav.innerHTML = `
      <button type="button" class="kb-subtab-write px-3 py-1.5 font-medium border-b-2 border-blue-600 text-blue-600" data-subtab="write">Write</button>
      <button type="button" class="kb-subtab-preview px-3 py-1.5 font-medium text-slate-600 hover:text-slate-900" data-subtab="preview">Preview</button>
    `;

    // Preview Pane
    const preview = document.createElement('div');
    preview.className = 'kb-editor-preview flex-1 p-3 text-sm text-slate-800 overflow-y-auto border-t md:border-t-0 md:border-l border-slate-200 bg-slate-50/50 kb-prose';
    preview.style.minHeight = this.minHeight;

    root.appendChild(tabNav);
    workspace.appendChild(textarea);
    workspace.appendChild(preview);
    root.appendChild(workspace);

    this.textarea = textarea;
    this.preview = preview;
    this.tabNav = tabNav;
    this.workspace = workspace;

    this._bindEvents(root);
    this._applyMode(this.mode);

    return root;
  }

  _bindEvents(root) {
    // Input & typing
    this.textarea.addEventListener('input', () => {
      this.value = this.textarea.value;
      this._scheduleRender();
      if (typeof this.onChange === 'function') {
        this.onChange(this.value);
      }
    });

    // Keyboard shortcuts
    this.textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        this._wrapSelection('**', '**');
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
        e.preventDefault();
        this._wrapSelection('*', '*');
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'm') {
        e.preventDefault();
        this._wrapSelection('$', '$');
      }
    });

    // Toolbar buttons
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;

      const action = btn.dataset.action;
      if (action) {
        e.preventDefault();
        this._handleAction(action);
        return;
      }

      const insertText = btn.dataset.insert;
      if (insertText) {
        e.preventDefault();
        this._insertAtCursor(insertText);
        return;
      }

      const viewMode = btn.dataset.view;
      if (viewMode) {
        e.preventDefault();
        this._applyMode(viewMode);
        root.querySelectorAll('.kb-tab-btn').forEach(b => {
          b.className = 'kb-tab-btn px-2.5 py-1 text-xs rounded-md font-medium ' +
            (b.dataset.view === viewMode ? 'bg-white shadow-xs text-slate-900 font-semibold' : 'text-slate-500 hover:text-slate-800');
        });
        return;
      }

      const subtab = btn.dataset.subtab;
      if (subtab) {
        e.preventDefault();
        this._switchSubtab(subtab);
      }
    });
  }

  _handleAction(action) {
    switch (action) {
      case 'bold': this._wrapSelection('**', '**'); break;
      case 'italic': this._wrapSelection('*', '*'); break;
      case 'strike': this._wrapSelection('~~', '~~'); break;
      case 'underline': this._wrapSelection('<u>', '</u>'); break;
      case 'code': this._wrapSelection('`', '`'); break;
      case 'mark': this._wrapSelection('<mark>', '</mark>'); break;
      case 'h3': this._prefixLine('### '); break;
      case 'bullet': this._prefixLine('- '); break;
      case 'number': this._prefixLine('1. '); break;
      case 'quote': this._prefixLine('> '); break;
      case 'hr': this._insertAtCursor('\n---\n'); break;
      case 'table':
        this._insertAtCursor('\n| Header 1 | Header 2 |\n| :--- | :--- |\n| Cell 1 | Cell 2 |\n');
        break;
      case 'math-inline': this._wrapSelection('$', '$'); break;
      case 'math-block': this._wrapSelection('$$\n', '\n$$'); break;
      case 'chem': this._wrapSelection('$\\ce{', '}$'); break;
    }
  }

  _wrapSelection(prefix, suffix) {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const current = this.textarea.value;
    const selected = current.substring(start, end);

    const replacement = prefix + (selected || 'text') + suffix;
    this.textarea.value = current.substring(0, start) + replacement + current.substring(end);

    const newCursor = start + prefix.length + (selected ? selected.length : 4);
    this.textarea.setSelectionRange(newCursor, newCursor);
    this.textarea.focus();

    this.value = this.textarea.value;
    this._scheduleRender();
    if (this.onChange) this.onChange(this.value);
  }

  _prefixLine(prefix) {
    const start = this.textarea.selectionStart;
    const current = this.textarea.value;
    const lineStart = current.lastIndexOf('\n', start - 1) + 1;

    this.textarea.value = current.substring(0, lineStart) + prefix + current.substring(lineStart);
    this.textarea.focus();

    this.value = this.textarea.value;
    this._scheduleRender();
    if (this.onChange) this.onChange(this.value);
  }

  _insertAtCursor(text) {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const current = this.textarea.value;

    this.textarea.value = current.substring(0, start) + text + current.substring(end);
    const newPos = start + text.length;
    this.textarea.setSelectionRange(newPos, newPos);
    this.textarea.focus();

    this.value = this.textarea.value;
    this._scheduleRender();
    if (this.onChange) this.onChange(this.value);
  }

  _applyMode(mode) {
    this.mode = mode;
    if (mode === 'split') {
      this.tabNav.classList.add('hidden');
      this.textarea.classList.remove('hidden');
      this.preview.classList.remove('hidden');
      this.workspace.className = 'kb-editor-workspace flex-1 flex flex-col md:flex-row relative';
    } else {
      this.tabNav.classList.remove('hidden');
      this.workspace.className = 'kb-editor-workspace flex-1 flex flex-col relative';
      this._switchSubtab('write');
    }
    this._scheduleRender();
  }

  _switchSubtab(tab) {
    const writeBtn = this.tabNav.querySelector('[data-subtab="write"]');
    const previewBtn = this.tabNav.querySelector('[data-subtab="preview"]');

    if (tab === 'write') {
      this.textarea.classList.remove('hidden');
      this.preview.classList.add('hidden');
      writeBtn.className = 'kb-subtab-write px-3 py-1.5 font-medium border-b-2 border-blue-600 text-blue-600';
      previewBtn.className = 'kb-subtab-preview px-3 py-1.5 font-medium text-slate-600 hover:text-slate-900';
      this.textarea.focus();
    } else {
      this.textarea.classList.add('hidden');
      this.preview.classList.remove('hidden');
      previewBtn.className = 'kb-subtab-preview px-3 py-1.5 font-medium border-b-2 border-blue-600 text-blue-600';
      writeBtn.className = 'kb-subtab-write px-3 py-1.5 font-medium text-slate-600 hover:text-slate-900';
      this._renderPreview();
    }
  }

  _scheduleRender() {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this._renderPreview();
    }, 100);
  }

  _renderPreview() {
    const raw = this.textarea.value;
    if (!raw.trim()) {
      this.preview.innerHTML = `<p class="text-slate-400 italic text-xs">Preview will appear here...</p>`;
      return;
    }

    try {
      this.preview.innerHTML = Sanitizer.renderSTEMMarkdown(raw);
    } catch (err) {
      this.preview.innerHTML = `<span class="text-xs text-red-500">Preview rendering error: ${Sanitizer.escapeHTML(err.message)}</span>`;
    }
  }

  getValue() {
    return this.textarea.value;
  }

  setValue(val) {
    this.value = val || '';
    if (this.textarea) {
      this.textarea.value = this.value;
      this._scheduleRender();
    }
  }

  destroy() {
    clearTimeout(this.debounceTimer);
    this.element.remove();
  }
}
