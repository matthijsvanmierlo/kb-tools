/**
 * ExportDialog Component (KB-COMP-009)
 * Universal dialog for CSV exports, mail-merge presets, and data downloads.
 */

import { toCSV, suggestDelimiter } from '../core/csv.js';
import { getExportPresetTemplate, downloadCSVTemplate } from '../core/csv-templates.js';
import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

export class ExportDialog {
  /**
   * Open the export dialog.
   *
   * @param {object} params
   * @param {string} [params.title='Export Data']
   * @param {Array<{
   *   id: string,
   *   label: string,
   *   description: string,
   *   defaultFilename?: string,
   *   supportsAccessCodes?: boolean,
   *   supportsQuestions?: boolean,
   *   customAction?: { label: string, icon?: string, run: (opts: any) => Promise<void> },
   *   choice?: { label: string, options: Array<{ value: string, label: string }> },
   *   build: (opts: { delimiter: string, decimal: string, includeAccessCodes: boolean, includeQuestions: boolean, choice?: string }) => Promise<{ headers: string[], rows: object[], filename?: string }>
   * }>} params.presets
   * @param {object} [params.context]
   * @returns {Promise<void>}
   */
  static async open({ title = 'Export Data', presets = [], context = {} }) {
    if (!presets || !presets.length) return;

    let selectedPresetId = presets[0].id;
    let delimiter = suggestDelimiter();
    let decimal = delimiter === ';' ? ',' : '.';
    let includeAccessCodes = false;
    let includeQuestions = false;
    const choices = {}; // presetId → selected value of that preset's `choice`

    let currentResult = { headers: [], rows: [], filename: 'export.csv' };
    let isBuilding = false;

    const dialog = document.createElement('sl-dialog');
    dialog.setAttribute('label', title);
    dialog.className = 'kb-export-dialog';
    dialog.style.setProperty('--width', '680px');

    const updatePreviewAndCounts = async () => {
      isBuilding = true;
      const spinner = dialog.querySelector('#export-loading-indicator');
      const tableContainer = dialog.querySelector('#export-preview-table-container');
      const rowCountEl = dialog.querySelector('#export-row-count');
      const customActionBtn = dialog.querySelector('#btn-export-custom-action');

      if (spinner) spinner.classList.remove('hidden');

      const preset = presets.find(p => p.id === selectedPresetId) || presets[0];

      // Toggle option visibility based on preset capabilities
      const codeOptionWrap = dialog.querySelector('#wrap-option-access-codes');
      if (codeOptionWrap) {
        codeOptionWrap.style.display = preset.supportsAccessCodes ? 'block' : 'none';
      }
      const questionsOptionWrap = dialog.querySelector('#wrap-option-questions');
      if (questionsOptionWrap) {
        questionsOptionWrap.style.display = preset.supportsQuestions ? 'block' : 'none';
      }
      const choiceWrap = dialog.querySelector('#wrap-option-choice');
      const choiceSelect = dialog.querySelector('#export-select-choice');
      if (choiceWrap && choiceSelect) {
        const opts = preset.choice?.options || [];
        choiceWrap.style.display = opts.length ? 'block' : 'none';
        if (opts.length) {
          if (!opts.some(o => o.value === choices[preset.id])) choices[preset.id] = opts[0].value;
          dialog.querySelector('#export-choice-label').textContent = preset.choice.label;
          choiceSelect.innerHTML = opts.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
          choiceSelect.value = choices[preset.id];
        }
      }

      if (customActionBtn) {
        if (preset.customAction) {
          customActionBtn.classList.remove('hidden');
          customActionBtn.textContent = preset.customAction.label;
          if (preset.customAction.icon) {
            customActionBtn.innerHTML = `<sl-icon slot="prefix" name="${preset.customAction.icon}"></sl-icon> ${preset.customAction.label}`;
          }
        } else {
          customActionBtn.classList.add('hidden');
        }
      }

      try {
        currentResult = await preset.build({
          delimiter,
          decimal,
          includeAccessCodes: preset.supportsAccessCodes ? includeAccessCodes : false,
          includeQuestions: preset.supportsQuestions ? includeQuestions : false,
          choice: choices[preset.id]
        });

        const rows = currentResult.rows || [];
        const headers = currentResult.headers || (rows[0] ? Object.keys(rows[0]) : []);

        if (rowCountEl) {
          rowCountEl.textContent = `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;
        }

        if (tableContainer) {
          if (!rows.length) {
            tableContainer.innerHTML = '<div class="p-4 text-center text-xs text-slate-400">No rows to display</div>';
          } else {
            const previewRows = rows.slice(0, 3);
            tableContainer.innerHTML = `
              <div class="overflow-x-auto max-h-48 border border-slate-200 rounded-lg">
                <table class="w-full text-left text-xs border-collapse">
                  <thead class="bg-slate-100 text-slate-700 sticky top-0 border-b border-slate-200">
                    <tr>
                      ${headers.slice(0, 8).map(h => `<th class="p-2 font-semibold whitespace-nowrap">${esc(h)}</th>`).join('')}
                      ${headers.length > 8 ? '<th class="p-2 font-semibold text-slate-400">...</th>' : ''}
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 bg-white">
                    ${previewRows.map(r => `
                      <tr class="hover:bg-slate-50">
                        ${headers.slice(0, 8).map(h => `<td class="p-2 whitespace-nowrap text-slate-600 max-w-[140px] truncate">${esc(r[h])}</td>`).join('')}
                        ${headers.length > 8 ? '<td class="p-2 text-slate-400">...</td>' : ''}
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `;
          }
        }
      } catch (err) {
        console.error('Error building export preview:', err);
        if (tableContainer) {
          tableContainer.innerHTML = `<div class="p-3 text-xs text-rose-600 bg-rose-50 rounded">Error: ${esc(err.message)}</div>`;
        }
      } finally {
        if (spinner) spinner.classList.add('hidden');
        isBuilding = false;
      }
    };

    dialog.innerHTML = `
      <div class="space-y-5 text-sm">
        <!-- PII Notice -->
        <div class="rounded-lg bg-amber-50/80 border border-amber-200 p-3 text-xs text-amber-900 flex items-start gap-2">
          <sl-icon name="shield-exclamation" class="text-amber-600 text-base shrink-0 mt-0.5"></sl-icon>
          <div>
            <strong>Privacy notice:</strong> This file contains student names and identifiers. Store it where other student records are kept according to your school policy.
          </div>
        </div>

        <!-- Preset Radio List -->
        <div class="space-y-2">
          <label class="text-xs font-bold uppercase tracking-wider text-slate-500">Choose Export Format</label>
          <div class="space-y-2" id="export-preset-radio-group">
            ${presets.map((p, idx) => `
              <label class="flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${idx === 0 ? 'border-blue-500 bg-blue-50/40 ring-1 ring-blue-500' : 'border-slate-200 bg-white hover:bg-slate-50'}">
                <input type="radio" name="export-preset" value="${esc(p.id)}" ${idx === 0 ? 'checked' : ''} class="mt-1 text-blue-600 focus:ring-blue-500">
                <div class="min-w-0">
                  <div class="font-semibold text-slate-900 text-sm">${esc(p.label)}</div>
                  <div class="text-xs text-slate-500 mt-0.5">${esc(p.description)}</div>
                </div>
              </label>
            `).join('')}
          </div>
        </div>

        <!-- Options Section -->
        <div class="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-3">
          <div class="text-xs font-bold uppercase tracking-wider text-slate-500">Format & Options</div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="text-xs font-medium text-slate-700 block mb-1">CSV Delimiter</label>
              <select id="export-select-delimiter" class="w-full text-xs rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
                <option value="," ${delimiter === ',' ? 'selected' : ''}>Comma (,)</option>
                <option value=";" ${delimiter === ';' ? 'selected' : ''}>Semicolon (;)</option>
              </select>
            </div>
            <div>
              <label class="text-xs font-medium text-slate-700 block mb-1">Decimal Separator</label>
              <select id="export-select-decimal" class="w-full text-xs rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
                <option value="." ${decimal === '.' ? 'selected' : ''}>Dot (.)</option>
                <option value="," ${decimal === ',' ? 'selected' : ''}>Comma (,)</option>
              </select>
            </div>
          </div>

          <!-- Checkboxes -->
          <div class="space-y-2 pt-1">
            <div id="wrap-option-access-codes" style="display: none;">
              <label class="flex items-start gap-2 cursor-pointer text-xs text-slate-700">
                <input type="checkbox" id="check-include-access-codes" class="rounded text-blue-600 mt-0.5">
                <div>
                  <span class="font-medium">Include Access Codes</span>
                  <p class="text-[11px] text-amber-700 mt-0.5">Codes are secrets. Only include them if this file will be stored securely.</p>
                </div>
              </label>
            </div>

            <div id="wrap-option-choice" style="display: none;">
              <label class="flex flex-col gap-1 text-xs text-slate-700">
                <span class="font-medium" id="export-choice-label"></span>
                <select id="export-select-choice" class="text-xs rounded-lg border-slate-300 py-1.5"></select>
              </label>
            </div>

            <div id="wrap-option-questions" style="display: none;">
              <label class="flex items-center gap-2 cursor-pointer text-xs text-slate-700">
                <input type="checkbox" id="check-include-questions" class="rounded text-blue-600">
                <span class="font-medium">Include per-question scores and comments</span>
              </label>
            </div>
          </div>
        </div>

        <!-- Preview Section -->
        <div class="space-y-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
              Preview (first 3 rows)
              <span id="export-loading-indicator" class="hidden text-blue-600"><sl-spinner></sl-spinner></span>
            </span>
            <span id="export-row-count" class="font-medium text-slate-600 font-mono">0 rows</span>
          </div>
          <div id="export-preview-table-container"></div>
        </div>

        <!-- Mail Merge Tips Expander -->
        <details class="group rounded-xl border border-slate-200 bg-slate-50/50 text-xs">
          <summary class="cursor-pointer font-semibold text-slate-700 p-3 select-none flex items-center justify-between">
            <span>Mail-merge instructions (Gmail, Outlook, Sheets)</span>
            <sl-icon name="chevron-down" class="group-open:rotate-180 transition-transform text-slate-400"></sl-icon>
          </summary>
          <div class="p-3 pt-0 text-slate-600 space-y-2 border-t border-slate-200/60 mt-1">
            <p><strong>Gmail + Google Sheets:</strong> Import CSV into Google Sheets. In Gmail, start a message, click "Mail merge", select the Sheet, use <code class="bg-slate-200/60 px-1 rounded font-mono">@FirstName</code> and paste <code class="bg-slate-200/60 px-1 rounded font-mono">@Link</code>.</p>
            <p><strong>Outlook / Word:</strong> Use standard mail merge fields like <code class="bg-slate-200/60 px-1 rounded font-mono">«FirstName»</code> and <code class="bg-slate-200/60 px-1 rounded font-mono">«Link»</code>. Insert link as a HYPERLINK field so URLs do not wrap.</p>
            <p><strong>Thunderbird:</strong> Use the Mail Merge add-on with <code class="bg-slate-200/60 px-1 rounded font-mono">{{FirstName}}</code> and <code class="bg-slate-200/60 px-1 rounded font-mono">{{Link}}</code>.</p>
          </div>
        </details>
      </div>

      <!-- Footer Buttons -->
      <div slot="footer" class="flex flex-wrap items-center justify-between gap-2 w-full">
        <sl-button variant="default" id="btn-export-close">Close</sl-button>
        <div class="flex flex-wrap items-center gap-2">
          <sl-button variant="default" id="btn-export-download-template" title="Download a blank or sample CSV template for this format">
            <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Download Template
          </sl-button>
          <sl-button variant="default" id="btn-export-copy-table">
            <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy as table
          </sl-button>
          <sl-button variant="neutral" id="btn-export-custom-action" class="hidden"></sl-button>
          <sl-button variant="primary" id="btn-export-download-csv">
            <sl-icon slot="prefix" name="download"></sl-icon> Download CSV
          </sl-button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);
    await dialog.show();

    // Setup event listeners
    const presetLabels = dialog.querySelectorAll('#export-preset-radio-group label');
    dialog.querySelectorAll('input[name="export-preset"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        selectedPresetId = e.target.value;
        presetLabels.forEach(l => {
          const r = l.querySelector('input');
          if (r.checked) {
            l.className = 'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors border-blue-500 bg-blue-50/40 ring-1 ring-blue-500';
          } else {
            l.className = 'flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors border-slate-200 bg-white hover:bg-slate-50';
          }
        });
        updatePreviewAndCounts();
      });
    });

    dialog.querySelector('#export-select-delimiter')?.addEventListener('change', (e) => {
      delimiter = e.target.value;
      updatePreviewAndCounts();
    });

    dialog.querySelector('#export-select-decimal')?.addEventListener('change', (e) => {
      decimal = e.target.value;
      updatePreviewAndCounts();
    });

    dialog.querySelector('#check-include-access-codes')?.addEventListener('change', (e) => {
      includeAccessCodes = e.target.checked;
      updatePreviewAndCounts();
    });

    dialog.querySelector('#export-select-choice')?.addEventListener('change', (e) => {
      choices[selectedPresetId] = e.target.value;
      updatePreviewAndCounts();
    });

    dialog.querySelector('#check-include-questions')?.addEventListener('change', (e) => {
      includeQuestions = e.target.checked;
      updatePreviewAndCounts();
    });

    // Copy as Table (TSV)
    dialog.querySelector('#btn-export-copy-table')?.addEventListener('click', async () => {
      if (!currentResult.rows || !currentResult.rows.length) {
        toast.info('No data to copy');
        return;
      }
      const headers = currentResult.headers;
      const rows = currentResult.rows;

      // Construct TSV: headers tab-separated, rows tab-separated, no internal CRLF
      const headerLine = headers.join('\t');
      const dataLines = rows.map(r => {
        return headers.map(h => {
          let val = r[h];
          if (val === null || val === undefined) return '';
          if (typeof val === 'boolean') return val ? 'Yes' : 'No';
          let str = String(val).replace(/[\r\n]+/g, ' ').replace(/\t/g, ' ');
          return str;
        }).join('\t');
      });

      const tsvContent = [headerLine, ...dataLines].join('\n');
      try {
        await navigator.clipboard.writeText(tsvContent);
        toast.success('Copied table to clipboard (TSV)');
      } catch (err) {
        toast.error('Failed to copy table: ' + err.message);
      }
    });

    // Download CSV
    dialog.querySelector('#btn-export-download-csv')?.addEventListener('click', () => {
      if (!currentResult.rows || !currentResult.rows.length) {
        toast.info('No data to download');
        return;
      }
      const csvStr = toCSV(currentResult.rows, currentResult.headers, { delimiter, decimal });
      const blob = new Blob([csvStr], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = currentResult.filename || 'export.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Downloaded ' + a.download);
    });

    // Download Preset Template
    dialog.querySelector('#btn-export-download-template')?.addEventListener('click', () => {
      const preset = presets.find(p => p.id === selectedPresetId) || presets[0];
      const templateCSV = getExportPresetTemplate(preset, currentResult.headers);
      const cleanId = (preset.id || 'export').replace(/[^a-z0-9_-]+/gi, '_');
      downloadCSVTemplate(`${cleanId}_template.csv`, templateCSV);
      toast.success(`Downloaded template for ${preset.label || 'preset'}`);
    });

    // Custom Action (e.g. download ZIP)
    dialog.querySelector('#btn-export-custom-action')?.addEventListener('click', async () => {
      const preset = presets.find(p => p.id === selectedPresetId);
      if (preset?.customAction?.run) {
        await preset.customAction.run({
          delimiter,
          decimal,
          includeAccessCodes,
          includeQuestions
        });
      }
    });

    dialog.querySelector('#btn-export-close')?.addEventListener('click', () => {
      dialog.hide();
    });

    dialog.addEventListener('sl-after-hide', () => {
      dialog.remove();
    });

    // Initial load
    await updatePreviewAndCounts();
  }
}
