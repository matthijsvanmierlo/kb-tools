/**
 * GradesImportDialog Component (KB-COMP-010)
 * Dialog for importing grades from wide CSVs or LMS exports with live diff preview.
 * Supports file upload, direct spreadsheet pasting, and downloading custom CSV templates.
 */

import { parseGradesCSV, planGradesImport } from '../modules/gradebook/gradebook-csv.js';
import { getGradesCSVTemplate, downloadCSVTemplate } from '../core/csv-templates.js';
import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

export class GradesImportDialog {
  /**
   * Open the grades import dialog.
   *
   * @param {object} params
   * @param {object} params.course
   * @param {Array<object>} params.students
   * @param {Array<object>} params.assignments
   * @param {Map<string, object>} params.gradesMap
   * @param {(changes: Array<object>) => Promise<void>} params.onApply
   */
  static async open({ course, students = [], assignments = [], gradesMap = new Map(), onApply }) {
    const dialog = document.createElement('sl-dialog');
    dialog.setAttribute('label', `Import Scores from CSV · ${course?.name || 'Class'}`);
    dialog.className = 'kb-grades-import-dialog';
    dialog.style.setProperty('--width', '680px');

    let currentPlan = null;

    dialog.innerHTML = `
      <div class="space-y-4 text-sm">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-slate-500">
          <p class="text-xs text-slate-600">
            Upload a CSV/TSV file or paste cells directly from Google Sheets or Excel. Column headers matching assignment titles will be updated.
          </p>
          <sl-button size="small" variant="default" id="btn-grades-top-template" class="shrink-0">
            <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Download CSV Template
          </sl-button>
        </div>

        <sl-tab-group id="grades-import-tabs">
          <sl-tab slot="nav" panel="tab-file" active>
            <sl-icon slot="prefix" name="file-earmark-arrow-up"></sl-icon> Upload File
          </sl-tab>
          <sl-tab slot="nav" panel="tab-paste">
            <sl-icon slot="prefix" name="clipboard"></sl-icon> Paste from Spreadsheet
          </sl-tab>

          <!-- Drop zone & file picker -->
          <sl-tab-panel name="tab-file">
            <div id="grades-drop-zone" class="mt-3 border-2 border-dashed border-slate-300 rounded-xl p-6 text-center hover:border-blue-400 bg-slate-50 transition-colors cursor-pointer space-y-2">
              <sl-icon name="cloud-arrow-up" class="text-3xl text-slate-400"></sl-icon>
              <div class="text-xs font-semibold text-slate-700">Drop CSV/TSV file here or click to browse</div>
              <div class="text-[11px] text-slate-400">Supports .csv, .tsv, and LMS exports</div>
              <input type="file" id="input-grades-file" accept=".csv,.tsv,.txt" class="hidden" />
            </div>
          </sl-tab-panel>

          <!-- Paste Panel -->
          <sl-tab-panel name="tab-paste">
            <div class="mt-3 space-y-2">
              <p class="text-xs text-slate-500">
                Copy cells directly from Google Sheets or Excel and paste below:
              </p>
              <sl-textarea id="grades-paste-textarea" rows="6" placeholder="StudentID&#9;StudentName&#9;Quiz 1&#9;Homework 1&#10;S101&#9;Emma Watson&#9;95&#9;100"></sl-textarea>
              <div class="flex items-center justify-between">
                <span id="grades-paste-row-count" class="text-xs text-slate-400">0 rows detected</span>
                <sl-button size="small" variant="neutral" id="btn-grades-process-paste">
                  <sl-icon slot="prefix" name="arrow-clockwise"></sl-icon> Preview Pasted Scores
                </sl-button>
              </div>
            </div>
          </sl-tab-panel>
        </sl-tab-group>

        <!-- Plan preview container -->
        <div id="grades-plan-container" class="space-y-3 hidden">
          <!-- Summary chips -->
          <div id="grades-plan-summary" class="flex flex-wrap items-center gap-2"></div>

          <!-- Changes preview table -->
          <div class="border border-slate-200 rounded-lg overflow-hidden max-h-56 overflow-y-auto">
            <table class="w-full text-left text-xs border-collapse">
              <thead class="bg-slate-100 text-slate-700 sticky top-0 border-b border-slate-200">
                <tr>
                  <th class="p-2 font-semibold">Student</th>
                  <th class="p-2 font-semibold">Assignment</th>
                  <th class="p-2 font-semibold">Current</th>
                  <th class="p-2 font-semibold">New</th>
                </tr>
              </thead>
              <tbody id="grades-plan-tbody" class="divide-y divide-slate-100 bg-white"></tbody>
            </table>
          </div>
        </div>
      </div>

      <div slot="footer" class="flex flex-wrap items-center justify-between gap-2 w-full">
        <sl-button size="small" variant="default" id="btn-grades-footer-template">
          <sl-icon slot="prefix" name="download"></sl-icon> Download CSV Template
        </sl-button>
        <div class="flex items-center gap-2">
          <sl-button variant="default" id="btn-grades-import-cancel">Cancel</sl-button>
          <sl-button variant="primary" id="btn-grades-import-apply" disabled>
            <sl-icon slot="prefix" name="check2"></sl-icon> Apply Changes
          </sl-button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);
    await dialog.show();

    const dropZone = dialog.querySelector('#grades-drop-zone');
    const fileInput = dialog.querySelector('#input-grades-file');
    const pasteTextarea = dialog.querySelector('#grades-paste-textarea');
    const pasteRowCount = dialog.querySelector('#grades-paste-row-count');
    const processPasteBtn = dialog.querySelector('#btn-grades-process-paste');
    const planContainer = dialog.querySelector('#grades-plan-container');
    const planSummary = dialog.querySelector('#grades-plan-summary');
    const planTbody = dialog.querySelector('#grades-plan-tbody');
    const applyBtn = dialog.querySelector('#btn-grades-import-apply');
    const topTemplateBtn = dialog.querySelector('#btn-grades-top-template');
    const footerTemplateBtn = dialog.querySelector('#btn-grades-footer-template');

    // Download Template Handler
    const handleDownloadTemplate = () => {
      const templateCSV = getGradesCSVTemplate(course, assignments, students);
      const cleanName = (course?.name || 'grades').replace(/[^a-z0-9_-]+/gi, '_');
      downloadCSVTemplate(`${cleanName}_template.csv`, templateCSV);
      toast.success('Downloaded grades CSV template');
    };
    topTemplateBtn?.addEventListener('click', handleDownloadTemplate);
    footerTemplateBtn?.addEventListener('click', handleDownloadTemplate);

    // Process CSV / TSV text (used by both file upload and paste)
    const processCSVText = (text) => {
      try {
        const parsed = parseGradesCSV(text);
        const plan = planGradesImport({
          parsed,
          course,
          students,
          assignments,
          gradesMap
        });

        currentPlan = plan;

        // Render summary
        planSummary.innerHTML = `
          <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
            <sl-icon name="pencil-square"></sl-icon> ${plan.changes.length} ${plan.changes.length === 1 ? 'change' : 'changes'} planned
          </span>
          <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
            ${plan.matchedColumns.length} columns matched
          </span>
          ${plan.unmatchedColumns.length ? `
            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200" title="Columns not found: ${esc(plan.unmatchedColumns.join(', '))}">
              <sl-icon name="exclamation-circle"></sl-icon> ${plan.unmatchedColumns.length} unmatched
            </span>` : ''}
          ${plan.unknownStudents.length ? `
            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200" title="Student IDs not in class: ${esc(plan.unknownStudents.join(', '))}">
              <sl-icon name="person-x"></sl-icon> ${plan.unknownStudents.length} unknown students
            </span>` : ''}
        `;

        if (!plan.changes.length) {
          planTbody.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-slate-400">No cell changes detected. Scores in the file match current grades.</td></tr>';
          applyBtn.disabled = true;
        } else {
          planTbody.innerHTML = plan.changes.map(c => {
            const beforeStr = c.before
              ? (c.before.status === 'missing' ? 'M' : (c.before.status === 'exempt' ? 'E' : (c.before.status === 'late' ? `${c.before.raw_score ?? ''}L` : `${c.before.raw_score ?? '—'}`)))
              : '—';

            const afterStr = c.after.status === 'missing' ? 'M' : (c.after.status === 'exempt' ? 'E' : (c.after.status === 'late' ? `${c.after.raw_score ?? ''}L` : `${c.after.raw_score ?? '—'}`));

            return `
              <tr class="hover:bg-slate-50">
                <td class="p-2 font-medium text-slate-900">${esc(c.student_name || c.student_id)}</td>
                <td class="p-2 text-slate-600">${esc(c.assignment_title)}</td>
                <td class="p-2 text-slate-400 font-mono">${esc(beforeStr)}</td>
                <td class="p-2 text-blue-700 font-bold font-mono">${esc(afterStr)}</td>
              </tr>
            `;
          }).join('');
          applyBtn.disabled = false;
        }

        planContainer.classList.remove('hidden');
      } catch (err) {
        console.error('Failed to parse grades CSV:', err);
        toast.error('Could not parse data: ' + err.message);
      }
    };

    // File Handlers
    const processFile = async (file) => {
      try {
        const text = await file.text();
        processCSVText(text);
      } catch (err) {
        toast.error('Could not read file: ' + err.message);
      }
    };

    dropZone?.addEventListener('click', () => fileInput?.click());
    dropZone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('border-blue-500', 'bg-blue-50/50');
    });
    dropZone?.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-blue-500', 'bg-blue-50/50');
    });
    dropZone?.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-blue-500', 'bg-blue-50/50');
      const file = e.dataTransfer?.files?.[0];
      if (file) await processFile(file);
    });

    fileInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await processFile(file);
      fileInput.value = '';
    });

    // Paste Handlers
    pasteTextarea?.addEventListener('sl-input', () => {
      const lines = (pasteTextarea.value || '').trim().split(/\r?\n/).filter(Boolean);
      const rows = lines.length > 1 ? lines.length - 1 : lines.length;
      if (pasteRowCount) pasteRowCount.textContent = `${rows} ${rows === 1 ? 'row' : 'rows'} detected`;
    });

    processPasteBtn?.addEventListener('click', () => {
      const text = (pasteTextarea?.value || '').trim();
      if (!text) {
        toast.warning('Please paste spreadsheet data first.');
        return;
      }
      processCSVText(text);
    });

    // Apply Handler
    applyBtn?.addEventListener('click', async () => {
      if (!currentPlan || !currentPlan.changes.length) return;
      applyBtn.setAttribute('loading', '');
      try {
        if (typeof onApply === 'function') {
          await onApply(currentPlan.changes);
        }
        toast.success(`Successfully imported ${currentPlan.changes.length} grade updates.`);
        dialog.hide();
      } catch (err) {
        console.error('Error applying grade changes:', err);
        toast.error('Import failed: ' + err.message);
      } finally {
        applyBtn.removeAttribute('loading');
      }
    });

    dialog.querySelector('#btn-grades-import-cancel')?.addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', () => dialog.remove());
  }
}
