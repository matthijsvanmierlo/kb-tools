/**
 * Universal CSV Import Dialog Component
 * Supports uploading a CSV/TSV/JSON file or pasting cells directly from spreadsheets
 * (Excel, Google Sheets), with an option to download a CSV template and live preview.
 */

import { parseCSVWithValidation, showImportErrorsDialog } from '../core/validator.js';
import { downloadCSVTemplate } from '../core/csv-templates.js';
import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';

export class CSVImportDialog {
  /**
   * Open the universal CSV import dialog
   *
   * @param {object} opts
   * @param {string} opts.title - Dialog label (e.g. "Import Flashcards")
   * @param {string} [opts.subtitle] - Help description
   * @param {string} opts.templateFilename - Name for downloaded template (e.g. "flashcards_template.csv")
   * @param {string} opts.templateContent - CSV template content
   * @param {z.ZodSchema} [opts.schema] - Zod schema for single row
   * @param {boolean} [opts.acceptJson=false] - Whether to allow .json files
   * @param {Function} opts.onImport - Callback (items: Array<any>, rawText: string, meta: { filename?: string, isJson: boolean }) => Promise<void>
   * @returns {HTMLElement} The created sl-dialog element
   */
  static async open({
    title = 'Import CSV',
    subtitle = 'Upload a CSV/TSV file or paste rows directly from Google Sheets or Excel.',
    templateFilename = 'template.csv',
    templateContent = '',
    schema = null,
    acceptJson = false,
    onImport
  }) {
    const dialog = document.createElement('sl-dialog');
    dialog.setAttribute('label', title);
    dialog.className = 'kb-csv-import-dialog';
    dialog.style.setProperty('--width', '640px');

    let activeTab = 'file';
    let currentFile = null;
    let pendingText = '';
    let isProcessing = false;

    const acceptTypes = acceptJson ? '.csv,.tsv,.txt,.json' : '.csv,.tsv,.txt';

    dialog.innerHTML = `
      <div class="space-y-4 py-1 text-sm">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-slate-500">
          <p class="text-xs text-slate-600">${Sanitizer.escapeHTML(subtitle)}</p>
          <sl-button size="small" variant="default" id="btn-top-download-template" class="shrink-0">
            <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Download CSV Template
          </sl-button>
        </div>

        <sl-tab-group id="import-mode-tabs">
          <sl-tab slot="nav" panel="tab-file" active>
            <sl-icon slot="prefix" name="file-earmark-arrow-up"></sl-icon> Upload File
          </sl-tab>
          <sl-tab slot="nav" panel="tab-paste">
            <sl-icon slot="prefix" name="clipboard"></sl-icon> Paste from Spreadsheet
          </sl-tab>

          <!-- Tab 1: File Upload -->
          <sl-tab-panel name="tab-file">
            <div class="mt-3 p-6 border-2 border-dashed border-slate-300 hover:border-blue-500 rounded-xl text-center bg-slate-50 transition-colors cursor-pointer" id="csv-drop-zone">
              <sl-icon name="cloud-arrow-up" class="text-3xl text-blue-500 mb-2"></sl-icon>
              <p class="font-medium text-slate-800 text-sm" id="csv-drop-title">Drop a CSV or TSV file here or click to browse</p>
              <p class="text-xs text-slate-500 mt-1" id="csv-drop-hint">Supports .csv, .tsv, and spreadsheet exports${acceptJson ? ' (or .json)' : ''}</p>
              <input type="file" id="csv-file-input" accept="${acceptTypes}" class="hidden" />
            </div>
            <div id="file-selection-info" class="hidden mt-2 p-2.5 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between text-xs text-blue-900">
              <div class="flex items-center gap-2 truncate">
                <sl-icon name="file-earmark-text" class="text-blue-600 shrink-0"></sl-icon>
                <span id="file-selected-name" class="font-semibold truncate"></span>
                <span id="file-selected-size" class="text-blue-500 font-mono"></span>
              </div>
              <button type="button" id="btn-clear-file" class="text-blue-600 hover:text-blue-900 font-medium ml-2">Change</button>
            </div>
          </sl-tab-panel>

          <!-- Tab 2: Paste Content -->
          <sl-tab-panel name="tab-paste">
            <div class="mt-3 space-y-2">
              <p class="text-xs text-slate-500">
                Copy cells directly from Google Sheets or Excel and paste below (tab or comma separated):
              </p>
              <sl-textarea id="csv-paste-textarea" rows="7" placeholder="Paste spreadsheet cells or CSV content here..."></sl-textarea>
              <div class="flex items-center justify-between text-xs text-slate-500">
                <span id="paste-row-count">0 rows detected</span>
                <span class="text-[11px] text-slate-400">Headers auto-detected (or plain 2-column data)</span>
              </div>
            </div>
          </sl-tab-panel>
        </sl-tab-group>

        <!-- Live Preview & Parsing Status -->
        <div id="csv-preview-container" class="hidden border border-slate-200 rounded-xl bg-slate-50/50 p-3.5 space-y-2.5">
          <div class="flex items-center justify-between text-xs">
            <div id="csv-preview-status" class="flex items-center gap-1.5 font-medium text-slate-700"></div>
            <span class="text-[11px] text-slate-400">Preview (up to 4 items)</span>
          </div>
          <div id="csv-preview-content" class="overflow-x-auto max-h-44 text-xs bg-white rounded-lg border border-slate-200 shadow-2xs divide-y divide-slate-100"></div>
          <div id="csv-preview-error" class="hidden text-xs text-red-600 bg-red-50 p-2.5 rounded-lg border border-red-200"></div>
        </div>
      </div>

      <div slot="footer" class="flex flex-wrap items-center justify-between gap-2 w-full">
        <sl-button size="small" variant="default" id="btn-footer-download-template">
          <sl-icon slot="prefix" name="download"></sl-icon> Download CSV Template
        </sl-button>
        <div class="flex items-center gap-2">
          <sl-button variant="default" id="btn-csv-import-cancel">Cancel</sl-button>
          <sl-button variant="primary" id="btn-csv-import-submit">
            <sl-icon slot="prefix" name="check-lg"></sl-icon> <span id="btn-csv-import-text">Import Data</span>
          </sl-button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    const tabs = dialog.querySelector('#import-mode-tabs');
    const dropZone = dialog.querySelector('#csv-drop-zone');
    const fileInput = dialog.querySelector('#csv-file-input');
    const fileInfo = dialog.querySelector('#file-selection-info');
    const fileNameEl = dialog.querySelector('#file-selected-name');
    const fileSizeEl = dialog.querySelector('#file-selected-size');
    const clearFileBtn = dialog.querySelector('#btn-clear-file');
    const pasteTextarea = dialog.querySelector('#csv-paste-textarea');
    const pasteRowCount = dialog.querySelector('#paste-row-count');
    const submitBtn = dialog.querySelector('#btn-csv-import-submit');
    const submitBtnText = dialog.querySelector('#btn-csv-import-text');
    const cancelBtn = dialog.querySelector('#btn-csv-import-cancel');
    const topTemplateBtn = dialog.querySelector('#btn-top-download-template');
    const footerTemplateBtn = dialog.querySelector('#btn-footer-download-template');

    const previewContainer = dialog.querySelector('#csv-preview-container');
    const previewStatus = dialog.querySelector('#csv-preview-status');
    const previewContent = dialog.querySelector('#csv-preview-content');
    const previewError = dialog.querySelector('#csv-preview-error');

    let parsedCache = null;

    // Handle Template Download
    const doDownloadTemplate = () => {
      downloadCSVTemplate(templateFilename, templateContent);
      toast.success(`Downloaded template: ${templateFilename}`);
    };
    topTemplateBtn?.addEventListener('click', doDownloadTemplate);
    footerTemplateBtn?.addEventListener('click', doDownloadTemplate);

    // Reactive Live Preview Helper
    const updatePreview = (text, isJsonFile, displayFilename) => {
      const trimmed = (text || '').trim();
      parsedCache = null;

      if (!trimmed) {
        previewContainer.classList.add('hidden');
        previewContent.innerHTML = '';
        previewError.classList.add('hidden');
        previewError.textContent = '';
        if (submitBtnText) submitBtnText.textContent = 'Import Data';
        return;
      }

      previewContainer.classList.remove('hidden');

      if (isJsonFile || (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          const parsed = JSON.parse(trimmed);
          const items = Array.isArray(parsed) ? parsed : (parsed.cards || parsed.events || [parsed]);
          parsedCache = { isJson: true, data: parsed, items, filename: displayFilename };

          previewStatus.innerHTML = `
            <span class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-100 font-semibold px-2 py-0.5 rounded-full text-[11px]">
              <sl-icon name="check-circle"></sl-icon> JSON Payload (${items.length} items)
            </span>
          `;
          previewError.classList.add('hidden');

          previewContent.innerHTML = items.slice(0, 4).map((it, idx) => {
            const fText = it.title || it.name || it.front?.text || it.front || `Item #${idx + 1}`;
            const bText = it.description || it.back?.text || it.back || (it.start_date ? `Date: ${it.start_date}` : '');
            return `
              <div class="p-2 flex items-center justify-between text-xs gap-3">
                <span class="font-medium text-slate-800 truncate">${Sanitizer.escapeHTML(String(fText))}</span>
                <span class="text-slate-500 truncate max-w-xs text-[11px]">${Sanitizer.escapeHTML(String(bText))}</span>
              </div>
            `;
          }).join('');

          if (submitBtnText) submitBtnText.textContent = `Import ${items.length} Items`;
          return;
        } catch {
          // Fall through to CSV parser if JSON parsing fails
        }
      }

      // CSV parsing with validation
      if (schema) {
        const res = parseCSVWithValidation(trimmed, schema);
        if (res.success && res.data && res.data.length > 0) {
          parsedCache = { isJson: false, data: res.data, filename: displayFilename };
          previewError.classList.add('hidden');
          previewStatus.innerHTML = `
            <span class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-100 font-semibold px-2 py-0.5 rounded-full text-[11px]">
              <sl-icon name="check-circle"></sl-icon> ${res.data.length} valid ${res.data.length === 1 ? 'row' : 'rows'} detected
            </span>
          `;

          previewContent.innerHTML = res.data.slice(0, 4).map((it, idx) => {
            const fText = it.title || it.name || it.front?.text || it.front || `Row #${idx + 1}`;
            const bText = it.description || it.back?.text || it.back || (it.start_date ? `${it.start_date} ${it.category ? `(${it.category})` : ''}` : '');
            return `
              <div class="p-2 flex items-center justify-between text-xs gap-3">
                <div class="truncate flex items-center gap-2">
                  <span class="text-slate-400 font-mono text-[10px]">#${idx + 1}</span>
                  <span class="font-semibold text-slate-800 truncate">${Sanitizer.escapeHTML(String(fText))}</span>
                </div>
                <span class="text-slate-500 truncate max-w-xs text-[11px] font-mono">${Sanitizer.escapeHTML(String(bText))}</span>
              </div>
            `;
          }).join('');

          if (submitBtnText) submitBtnText.textContent = `Import ${res.data.length} ${res.data.length === 1 ? 'Item' : 'Items'}`;
        } else {
          parsedCache = null;
          previewStatus.innerHTML = `
            <span class="inline-flex items-center gap-1 text-rose-700 bg-rose-100 font-semibold px-2 py-0.5 rounded-full text-[11px]">
              <sl-icon name="exclamation-triangle"></sl-icon> Validation Issues Found
            </span>
          `;
          const firstErr = res.errors?.[0];
          previewError.classList.remove('hidden');
          previewError.textContent = firstErr
            ? `Row ${firstErr.rowNumber}: ${firstErr.message} (${firstErr.fieldPath})`
            : 'Could not validate rows against required format.';
          previewContent.innerHTML = '';
          if (submitBtnText) submitBtnText.textContent = 'Import Data';
        }
      } else {
        if (submitBtnText) submitBtnText.textContent = 'Import Data';
      }
    };

    // Tab change
    tabs?.addEventListener('sl-tab-show', (e) => {
      activeTab = e.detail.name === 'tab-paste' ? 'paste' : 'file';
      if (activeTab === 'paste') {
        updatePreview(pasteTextarea?.value || '', false, 'pasted_data.csv');
      } else if (currentFile) {
        currentFile.text().then(t => updatePreview(t, currentFile.name.endsWith('.json'), currentFile.name));
      } else {
        updatePreview('', false, '');
      }
    });

    // File selection
    const handleFile = async (file) => {
      if (!file) return;
      currentFile = file;
      fileNameEl.textContent = file.name;
      fileSizeEl.textContent = `(${Math.round(file.size / 1024)} KB)`;
      fileInfo.classList.remove('hidden');
      dropZone.classList.add('hidden');

      try {
        const text = await file.text();
        updatePreview(text, acceptJson && file.name.endsWith('.json'), file.name);
      } catch (err) {
        console.warn('File read preview warning:', err);
      }
    };

    dropZone?.addEventListener('click', () => fileInput?.click());
    dropZone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('border-blue-500', 'bg-blue-50');
    });
    dropZone?.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-blue-500', 'bg-blue-50');
    });
    dropZone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-blue-500', 'bg-blue-50');
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFile(file);
    });

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) handleFile(file);
    });

    clearFileBtn?.addEventListener('click', () => {
      currentFile = null;
      fileInput.value = '';
      fileInfo.classList.add('hidden');
      dropZone.classList.remove('hidden');
      updatePreview('', false, '');
    });

    // Paste Textarea live update
    pasteTextarea?.addEventListener('sl-input', () => {
      const val = pasteTextarea.value || '';
      const lines = val.trim().split(/\r?\n/).filter(Boolean);
      const rows = lines.length > 1 ? lines.length - 1 : lines.length;
      pasteRowCount.textContent = `${rows} ${rows === 1 ? 'row' : 'rows'} detected`;
      updatePreview(val, false, 'pasted_data.csv');
    });

    // Submit Handler
    submitBtn?.addEventListener('click', async () => {
      if (isProcessing) return;

      let text = '';
      let isJson = false;
      let filename = 'pasted_data.csv';

      if (activeTab === 'file') {
        if (!currentFile) {
          toast.warning('Please select a file to import first.');
          return;
        }
        filename = currentFile.name;
        isJson = acceptJson && currentFile.name.endsWith('.json');
        try {
          text = await currentFile.text();
        } catch (err) {
          toast.danger('Failed to read file: ' + err.message);
          return;
        }
      } else {
        text = (pasteTextarea?.value || '').trim();
        if (!text) {
          toast.warning('Please paste spreadsheet data into the text box first.');
          return;
        }
        if (acceptJson && (text.startsWith('{') || text.startsWith('['))) {
          try {
            JSON.parse(text);
            isJson = true;
            filename = 'pasted_data.json';
          } catch {
            isJson = false;
          }
        }
      }

      if (!text.trim()) {
        toast.warning('No data provided to import.');
        return;
      }

      isProcessing = true;
      submitBtn.loading = true;
      submitBtn.disabled = true;

      try {
        if (isJson) {
          // JSON path
          const parsed = JSON.parse(text);
          await onImport(parsed, text, { filename, isJson: true });
          await dialog.hide();
        } else if (schema) {
          // Validated CSV path (use cache if available and matches)
          const res = (parsedCache && !parsedCache.isJson && parsedCache.data)
            ? { success: true, data: parsedCache.data }
            : parseCSVWithValidation(text, schema);

          if (!res.success) {
            showImportErrorsDialog(res.errors);
            isProcessing = false;
            submitBtn.loading = false;
            submitBtn.disabled = false;
            return;
          }
          await onImport(res.data, text, { filename, isJson: false });
          await dialog.hide();
        } else {
          // Generic CSV path without explicit schema
          await onImport(null, text, { filename, isJson: false });
          await dialog.hide();
        }
      } catch (err) {
        console.error('CSV import error:', err);
        toast.danger('Import failed: ' + err.message);
      } finally {
        isProcessing = false;
        submitBtn.loading = false;
        submitBtn.disabled = false;
      }
    });

    cancelBtn?.addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', () => dialog.remove());

    await dialog.show();
    return dialog;
  }
}
