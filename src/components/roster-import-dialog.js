import { storage } from '../core/storage.js';
import { generateUUID } from '../utils/uuid.js';
import { toast } from '../utils/toast.js';
import { Sanitizer } from '../core/sanitizer.js';
import { parseCSV } from '../core/csv.js';
import { detectColumns, normalizeRows, planMerge, parsePastedRoster } from '../core/roster-import.js';
import { parseOneRosterBundle } from '../core/oneroster.js';
import { AccessCodes } from '../core/access-codes.js';
import { ROSTER_CSV_TEMPLATE, downloadCSVTemplate } from '../core/csv-templates.js';

export class RosterImportDialog {
  /**
   * Open the roster import dialog
   * @param {object} opts
   * @param {object} opts.course - Gradebook course object
   * @param {Function} [opts.onDone] - Callback invoked on completion
   * @returns {HTMLElement} The created sl-dialog element
   */
  static async open({ course, onDone }) {
    const dialog = document.createElement('sl-dialog');
    dialog.label = `Import Roster — ${course?.name || 'Class'}`;
    dialog.style.setProperty('--width', '680px');
    dialog.className = 'kb-roster-import-dialog';

    const allStudents = await storage.table('gradebook_students').toArray().catch(() => []);
    const existingStudents = allStudents.filter(s => s.course_id === course.id);
    const otherClassStudents = allStudents.filter(s => s.course_id !== course.id);

    // State
    let step = 1; // 1: Source, 2: Mapping & Preview, 3: Merge Plan, 4: Complete
    let rawFields = [];
    let rawRows = [];
    let hasHeader = true;
    let detectedDelimiter = ',';
    let columnMapping = {};
    let mergePlan = null;
    let updateExisting = true;
    let allowAccessCodeOverwrite = false;
    let importedCounts = { added: 0, updated: 0 };

    const render = () => {
      if (step === 1) renderSourceStep();
      else if (step === 2) renderMappingStep();
      else if (step === 3) renderPlanStep();
      else if (step === 4) renderCompleteStep();
    };

    function renderSourceStep() {
      dialog.innerHTML = `
        <div class="space-y-4 py-1 text-sm">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-1 text-xs text-slate-500">
            <span>Upload a roster file or paste spreadsheet cells (Google Sheets / Excel):</span>
            <sl-button size="small" variant="default" id="btn-roster-download-template" class="shrink-0">
              <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Download CSV Template
            </sl-button>
          </div>

          <sl-tab-group id="import-tabs">
            <sl-tab slot="nav" panel="tab-file" active>
              <sl-icon slot="prefix" name="file-earmark-arrow-up"></sl-icon> Upload File
            </sl-tab>
            <sl-tab slot="nav" panel="tab-paste">
              <sl-icon slot="prefix" name="clipboard"></sl-icon> Paste Roster
            </sl-tab>
            <sl-tab slot="nav" panel="tab-oneroster">
              <sl-icon slot="prefix" name="file-earmark-zip"></sl-icon> OneRoster ZIP
            </sl-tab>

            <!-- File Upload Panel -->
            <sl-tab-panel name="tab-file">
              <div class="mt-3 p-6 border-2 border-dashed border-slate-300 hover:border-blue-500 rounded-xl text-center bg-slate-50 transition-colors cursor-pointer" id="file-drop-zone">
                <sl-icon name="cloud-arrow-up" class="text-4xl text-blue-500 mb-2"></sl-icon>
                <p class="font-medium text-slate-800">Drop a roster file here or click to browse</p>
                <p class="text-xs text-slate-500 mt-1">Supports CSV, TSV, TXT, or OneRoster ZIP</p>
                <input type="file" id="file-input" accept=".csv,.tsv,.txt,.zip" class="hidden" />
              </div>
            </sl-tab-panel>

            <!-- Paste Panel -->
            <sl-tab-panel name="tab-paste">
              <div class="mt-3 space-y-2">
                <p class="text-xs text-slate-500">
                  Paste cells copied from Google Sheets or Excel, CSV lines, or one student per line like <code>Emma Watson &lt;emma@school.org&gt;</code>.
                </p>
                <sl-textarea id="paste-input" rows="8" placeholder="StudentID&#9;Student Name&#9;Email&#10;S101&#9;Emma Watson&#9;emma@school.org"></sl-textarea>
                <div class="flex justify-end">
                  <sl-button size="small" variant="primary" id="btn-process-paste">
                    <sl-icon slot="prefix" name="arrow-right"></sl-icon> Next: Map Columns
                  </sl-button>
                </div>
              </div>
            </sl-tab-panel>

            <!-- OneRoster Panel -->
            <sl-tab-panel name="tab-oneroster">
              <div class="mt-3 p-6 border-2 border-dashed border-slate-300 hover:border-blue-500 rounded-xl text-center bg-slate-50 transition-colors cursor-pointer" id="oneroster-drop-zone">
                <sl-icon name="folder2-open" class="text-4xl text-amber-500 mb-2"></sl-icon>
                <p class="font-medium text-slate-800">Drop a OneRoster ZIP bundle here</p>
                <p class="text-xs text-slate-500 mt-1">Bundle should contain <code>classes.csv</code>, <code>users.csv</code>, and <code>enrollments.csv</code></p>
                <input type="file" id="oneroster-file-input" accept=".zip" class="hidden" />
              </div>
              <div id="oneroster-class-picker" class="hidden mt-3 p-3 bg-blue-50 border border-blue-200 rounded-xl space-y-2">
                <label class="block text-xs font-semibold text-slate-700">Select class from bundle to import:</label>
                <sl-select id="oneroster-select-class" size="small"></sl-select>
                <sl-button size="small" variant="primary" id="btn-oneroster-confirm">Use Selected Class</sl-button>
              </div>
            </sl-tab-panel>
          </sl-tab-group>
        </div>
        <div slot="footer" class="flex flex-wrap items-center justify-between gap-2 w-full">
          <sl-button size="small" variant="default" id="btn-footer-roster-template">
            <sl-icon slot="prefix" name="download"></sl-icon> Download CSV Template
          </sl-button>
          <sl-button variant="default" id="btn-cancel-import">Cancel</sl-button>
        </div>
      `;

      bindSourceStep();
    }

    function bindSourceStep() {
      dialog.querySelector('#btn-cancel-import')?.addEventListener('click', () => dialog.hide());

      const handleTemplateDownload = () => {
        downloadCSVTemplate('roster_template.csv', ROSTER_CSV_TEMPLATE);
        toast.success('Downloaded roster CSV template');
      };
      dialog.querySelector('#btn-roster-download-template')?.addEventListener('click', handleTemplateDownload);
      dialog.querySelector('#btn-footer-roster-template')?.addEventListener('click', handleTemplateDownload);

      // File upload handler
      const dropZone = dialog.querySelector('#file-drop-zone');
      const fileInput = dialog.querySelector('#file-input');

      dropZone?.addEventListener('click', () => fileInput?.click());
      dropZone?.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-blue-500', 'bg-blue-50'); });
      dropZone?.addEventListener('dragleave', () => { dropZone.classList.remove('border-blue-500', 'bg-blue-50'); });
      dropZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('border-blue-500', 'bg-blue-50');
        const file = e.dataTransfer?.files?.[0];
        if (file) handleSelectedFile(file);
      });

      fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) handleSelectedFile(file);
      });

      // Paste handler
      dialog.querySelector('#btn-process-paste')?.addEventListener('click', () => {
        const text = dialog.querySelector('#paste-input')?.value?.trim();
        if (!text) {
          toast.warning('Please paste roster text first.');
          return;
        }
        const parsed = parsePastedRoster(text);
        if (parsed.fields.length === 0 || parsed.rows.length === 0) {
          toast.warning('Could not detect any students in the pasted text.');
          return;
        }
        rawFields = parsed.fields;
        rawRows = parsed.rows;
        detectedDelimiter = text.includes('\t') ? 'Tab' : ',';
        const detected = detectColumns(rawFields);
        columnMapping = detected.mapping;
        step = 2;
        render();
      });

      // OneRoster drop handler
      const orDropZone = dialog.querySelector('#oneroster-drop-zone');
      const orFileInput = dialog.querySelector('#oneroster-file-input');
      orDropZone?.addEventListener('click', () => orFileInput?.click());
      orDropZone?.addEventListener('dragover', (e) => { e.preventDefault(); orDropZone.classList.add('border-blue-500', 'bg-blue-50'); });
      orDropZone?.addEventListener('dragleave', () => { orDropZone.classList.remove('border-blue-500', 'bg-blue-50'); });
      orDropZone?.addEventListener('drop', async (e) => {
        e.preventDefault();
        orDropZone.classList.remove('border-blue-500', 'bg-blue-50');
        const file = e.dataTransfer?.files?.[0];
        if (file) await handleOneRosterFile(file);
      });
      orFileInput?.addEventListener('change', async () => {
        const file = orFileInput.files?.[0];
        if (file) await handleOneRosterFile(file);
      });
    }

    async function handleSelectedFile(file) {
      if (file.name.toLowerCase().endsWith('.zip')) {
        await handleOneRosterFile(file);
        return;
      }

      const text = await file.text();
      detectedDelimiter = text.includes('\t') ? 'Tab' : (text.includes(';') ? ';' : ',');
      const parsed = parseCSV(text, { delimiter: detectedDelimiter === 'Tab' ? '\t' : undefined });
      if (!parsed.fields.length || !parsed.rows.length) {
        toast.danger('No readable rows found in file.');
        return;
      }
      rawFields = parsed.fields;
      rawRows = parsed.rows;
      const detected = detectColumns(rawFields);
      columnMapping = detected.mapping;
      step = 2;
      render();
    }

    async function handleOneRosterFile(file) {
      try {
        const bundle = await parseOneRosterBundle(file);
        if (!bundle.classes || bundle.classes.length === 0) {
          toast.danger('No valid classes found in OneRoster bundle.');
          return;
        }

        if (bundle.classes.length === 1) {
          applyOneRosterClass(bundle.classes[0]);
          return;
        }

        // Multiple classes: show class picker
        const picker = dialog.querySelector('#oneroster-class-picker');
        const select = dialog.querySelector('#oneroster-select-class');
        if (picker && select) {
          picker.classList.remove('hidden');
          select.innerHTML = bundle.classes.map((c, i) => `
            <sl-option value="${i}">${Sanitizer.escapeHTML(c.title)} (${c.students.length} students)</sl-option>
          `).join('');

          dialog.querySelector('#btn-oneroster-confirm')?.addEventListener('click', () => {
            const idx = parseInt(select.value, 10) || 0;
            applyOneRosterClass(bundle.classes[idx]);
          }, { once: true });
        }
      } catch (err) {
        toast.danger(`Error reading OneRoster ZIP: ${err.message}`);
      }
    }

    function applyOneRosterClass(cls) {
      rawFields = ['student_id', 'given_name', 'family_name', 'email'];
      rawRows = cls.students.map(s => ({
        student_id: s.student_id,
        given_name: s.given_name,
        family_name: s.family_name,
        email: s.email
      }));
      columnMapping = {
        student_id: 'student_id',
        full_name: null,
        given_name: 'given_name',
        family_name: 'family_name',
        email: 'email',
        access_code: null,
        notes: null
      };
      step = 2;
      render();
    }

    function renderMappingStep() {
      const targetFields = [
        { key: 'student_id', label: 'Student ID / SIS ID', required: true, canUseEmail: true },
        { key: 'full_name', label: 'Full Name', note: 'or first & last below' },
        { key: 'given_name', label: 'First / Given Name' },
        { key: 'family_name', label: 'Last / Family Name' },
        { key: 'email', label: 'Email Address' },
        { key: 'access_code', label: 'Access Code', note: 'optional' },
        { key: 'notes', label: 'Private Notes', note: 'optional' }
      ];

      const sampleRows = rawRows.slice(0, 5);

      dialog.innerHTML = `
        <div class="space-y-4 py-1 text-sm">
          <div class="flex items-center justify-between pb-2 border-b border-slate-200">
            <div>
              <h3 class="font-semibold text-slate-800">Map Columns</h3>
              <p class="text-xs text-slate-500">Detected ${rawRows.length} rows (${detectedDelimiter} separated)</p>
            </div>
            <label class="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
              <input type="checkbox" id="chk-has-header" ${hasHeader ? 'checked' : ''} class="rounded border-slate-300">
              <span>First row is header</span>
            </label>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-64 overflow-y-auto pr-1">
            ${targetFields.map(tf => {
              const currentVal = columnMapping[tf.key] || '';
              return `
                <div>
                  <label class="block text-xs font-semibold text-slate-700 mb-1 flex items-center justify-between">
                    <span>${tf.label} ${tf.required ? '<span class="text-rose-500">*</span>' : ''}</span>
                    ${tf.note ? `<span class="text-[10px] text-slate-400 font-normal">${tf.note}</span>` : ''}
                  </label>
                  <sl-select size="small" class="mapping-select w-full" data-target="${Sanitizer.escapeHTML(tf.key)}" value="${Sanitizer.escapeHTML(currentVal || '__none__')}">
                    <sl-option value="__none__">-- Do not import --</sl-option>
                    ${tf.canUseEmail ? '<sl-option value="__email__">(Use Email as Student ID)</sl-option>' : ''}
                    ${rawFields.map(f => `
                      <sl-option value="${Sanitizer.escapeHTML(f)}">${Sanitizer.escapeHTML(f)}</sl-option>
                    `).join('')}
                  </sl-select>
                </div>
              `;
            }).join('')}
          </div>

          <!-- Preview Table -->
          <div>
            <h4 class="text-xs font-semibold text-slate-700 mb-1.5">First ${sampleRows.length} Rows (Raw Data)</h4>
            <div class="border border-slate-200 rounded-lg overflow-x-auto text-xs max-h-36">
              <table class="w-full text-left border-collapse">
                <thead class="bg-slate-50 text-slate-600 font-semibold border-b">
                  <tr>
                    ${rawFields.map(f => `<th class="px-2.5 py-1.5 truncate max-w-[120px]">${Sanitizer.escapeHTML(f)}</th>`).join('')}
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${sampleRows.map(r => `
                    <tr>
                      ${rawFields.map(f => `<td class="px-2.5 py-1 truncate max-w-[120px]">${Sanitizer.escapeHTML(r[f] || '')}</td>`).join('')}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div slot="footer" class="flex justify-between items-center w-full">
          <sl-button variant="default" size="small" id="btn-back-to-source">
            <sl-icon slot="prefix" name="arrow-left"></sl-icon> Back
          </sl-button>
          <sl-button variant="primary" size="small" id="btn-proceed-to-plan">
            Preview Merge <sl-icon slot="suffix" name="arrow-right"></sl-icon>
          </sl-button>
        </div>
      `;

      bindMappingStep();
    }

    function bindMappingStep() {
      dialog.querySelector('#btn-back-to-source')?.addEventListener('click', () => {
        step = 1;
        render();
      });

      dialog.querySelectorAll('.mapping-select').forEach(sel => {
        sel.addEventListener('sl-change', () => {
          const target = sel.dataset.target;
          const val = sel.value;
          columnMapping[target] = (val === '__none__') ? null : val;
        });
      });

      dialog.querySelector('#chk-has-header')?.addEventListener('change', (e) => {
        hasHeader = e.target.checked;
      });

      dialog.querySelector('#btn-proceed-to-plan')?.addEventListener('click', () => {
        const hasId = columnMapping.student_id && columnMapping.student_id !== '__none__';
        const hasName = (columnMapping.full_name && columnMapping.full_name !== '__none__') ||
          (columnMapping.given_name && columnMapping.given_name !== '__none__') ||
          (columnMapping.family_name && columnMapping.family_name !== '__none__');

        if (!hasId) {
          toast.danger('Please map the Student ID column (or choose "Use Email as Student ID").');
          return;
        }
        if (!hasName) {
          toast.danger('Please map at least one Name column (Full Name or First/Last).');
          return;
        }

        const normalized = normalizeRows(rawRows, columnMapping);
        mergePlan = planMerge(existingStudents, normalized, { updateExisting, allowAccessCodeOverwrite, otherClassStudents });
        step = 3;
        render();
      });
    }

    function renderPlanStep() {
      const { add, update, unchanged, conflicts, duplicatesInFile } = mergePlan;

      dialog.innerHTML = `
        <div class="space-y-4 py-1 text-sm">
          <div>
            <h3 class="font-semibold text-slate-800">Merge Preview</h3>
            <p class="text-xs text-slate-500">Review changes before writing to database.</p>
          </div>

          <!-- Summary Pills -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
            <div class="p-2.5 rounded-lg border border-emerald-200 bg-emerald-50">
              <span class="block text-emerald-800 font-bold text-lg">${add.length}</span>
              <span class="text-emerald-700 font-medium">To Add</span>
            </div>
            <div class="p-2.5 rounded-lg border border-blue-200 bg-blue-50">
              <span class="block text-blue-800 font-bold text-lg">${update.length}</span>
              <span class="text-blue-700 font-medium">To Update</span>
            </div>
            <div class="p-2.5 rounded-lg border border-slate-200 bg-slate-50">
              <span class="block text-slate-700 font-bold text-lg">${unchanged.length}</span>
              <span class="text-slate-600 font-medium">Unchanged</span>
            </div>
            <div class="p-2.5 rounded-lg border ${conflicts.length || duplicatesInFile.length ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50'}">
              <span class="block ${conflicts.length || duplicatesInFile.length ? 'text-amber-800' : 'text-slate-700'} font-bold text-lg">${conflicts.length + duplicatesInFile.length}</span>
              <span class="${conflicts.length || duplicatesInFile.length ? 'text-amber-700' : 'text-slate-600'} font-medium">Skipped/Errors</span>
            </div>
          </div>

          <!-- Options -->
          <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
            <label class="flex items-center gap-2 cursor-pointer font-medium text-slate-700">
              <input type="checkbox" id="chk-update-existing" ${updateExisting ? 'checked' : ''} class="rounded border-slate-300">
              <span>Update names and emails of existing students</span>
            </label>
            ${columnMapping.access_code ? `
              <label class="flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                <input type="checkbox" id="chk-allow-codes" ${allowAccessCodeOverwrite ? 'checked' : ''} class="rounded border-slate-300">
                <span>Set access codes from file (may replace existing codes)</span>
              </label>
            ` : ''}
          </div>

          <!-- Details Accordion / Lists -->
          <div class="space-y-2 max-h-48 overflow-y-auto pr-1 text-xs">
            ${add.length > 0 ? `
              <details class="p-2 border rounded-lg bg-white" open>
                <summary class="font-semibold text-emerald-700 cursor-pointer">Students to Add (${add.length})</summary>
                <div class="mt-2 divide-y divide-slate-100 max-h-32 overflow-y-auto">
                  ${add.map(s => `
                    <div class="py-1 flex justify-between">
                      <span class="font-medium text-slate-800">${Sanitizer.escapeHTML(s.full_name)}</span>
                      <span class="font-mono text-slate-500">${Sanitizer.escapeHTML(s.student_id)}</span>
                    </div>
                  `).join('')}
                </div>
              </details>
            ` : ''}

            ${update.length > 0 ? `
              <details class="p-2 border rounded-lg bg-white">
                <summary class="font-semibold text-blue-700 cursor-pointer">Students with Updates (${update.length})</summary>
                <div class="mt-2 divide-y divide-slate-100 max-h-32 overflow-y-auto">
                  ${update.map(u => `
                    <div class="py-1">
                      <div class="font-medium text-slate-800">${Sanitizer.escapeHTML(u.incoming.full_name)} <span class="font-mono text-slate-400">(${Sanitizer.escapeHTML(u.incoming.student_id)})</span></div>
                      <div class="text-[11px] text-slate-500">
                        ${u.changes.map(c => `${Sanitizer.escapeHTML(c.field)}: "${Sanitizer.escapeHTML(c.from || 'none')}" → "${Sanitizer.escapeHTML(c.to)}"`).join(', ')}
                      </div>
                    </div>
                  `).join('')}
                </div>
              </details>
            ` : ''}

            ${conflicts.length > 0 ? `
              <details class="p-2 border border-rose-200 bg-rose-50/50 rounded-lg">
                <summary class="font-semibold text-rose-700 cursor-pointer">Rows with Errors (${conflicts.length})</summary>
                <div class="mt-2 divide-y divide-rose-100 max-h-32 overflow-y-auto">
                  ${conflicts.map(c => `
                    <div class="py-1 text-rose-800">
                      Row ${Sanitizer.escapeHTML(c.row?.rowNumber || '?')}: ${Sanitizer.escapeHTML(c.reason)}
                    </div>
                  `).join('')}
                </div>
              </details>
            ` : ''}
          </div>
        </div>
        <div slot="footer" class="flex justify-between items-center w-full">
          <sl-button variant="default" size="small" id="btn-back-to-mapping">
            <sl-icon slot="prefix" name="arrow-left"></sl-icon> Back
          </sl-button>
          <sl-button variant="primary" size="small" id="btn-execute-import" ${add.length === 0 && update.length === 0 ? 'disabled' : ''}>
            <sl-icon slot="prefix" name="check-lg"></sl-icon> Import ${add.length + update.length} Students
          </sl-button>
        </div>
      `;

      bindPlanStep();
    }

    function bindPlanStep() {
      dialog.querySelector('#btn-back-to-mapping')?.addEventListener('click', () => {
        step = 2;
        render();
      });

      dialog.querySelector('#chk-update-existing')?.addEventListener('change', (e) => {
        updateExisting = e.target.checked;
        const normalized = normalizeRows(rawRows, columnMapping);
        mergePlan = planMerge(existingStudents, normalized, { updateExisting, allowAccessCodeOverwrite, otherClassStudents });
        render();
      });

      dialog.querySelector('#chk-allow-codes')?.addEventListener('change', (e) => {
        allowAccessCodeOverwrite = e.target.checked;
        const normalized = normalizeRows(rawRows, columnMapping);
        mergePlan = planMerge(existingStudents, normalized, { updateExisting, allowAccessCodeOverwrite, otherClassStudents });
        render();
      });

      dialog.querySelector('#btn-execute-import')?.addEventListener('click', async () => {
        await executeImport();
      });
    }

    async function executeImport() {
      const { add, update } = mergePlan;
      const now = new Date().toISOString();
      const studentsTable = storage.table('gradebook_students');

      try {
        await storage.transaction('rw', [studentsTable], async () => {
          // Process additions
          for (const s of add) {
            await studentsTable.put({
              id: generateUUID(),
              course_id: course.id,
              student_id: s.student_id,
              full_name: s.full_name,
              given_name: s.given_name || undefined,
              family_name: s.family_name || undefined,
              email: s.email || undefined,
              access_code: s.access_code || undefined,
              notes: s.notes || undefined,
              created_at: now,
              updated_at: now
            });
          }

          // Process updates
          for (const u of update) {
            const rec = { ...u.existing, updated_at: now };
            for (const ch of u.changes) {
              rec[ch.field] = ch.to;
            }
            await studentsTable.put(rec);
          }
        });

        importedCounts = { added: add.length, updated: update.length };
        toast.success(`Import complete: ${add.length} added, ${update.length} updated.`);
        step = 4;
        render();
        if (onDone) onDone();
      } catch (err) {
        toast.danger(`Import failed: ${err.message}`);
      }
    }

    function renderCompleteStep() {
      dialog.innerHTML = `
        <div class="space-y-5 py-4 text-center">
          <div class="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto text-2xl">
            <sl-icon name="check-circle"></sl-icon>
          </div>
          <div>
            <h3 class="text-lg font-bold text-slate-800">Roster Updated!</h3>
            <p class="text-sm text-slate-500 mt-1">
              Successfully imported <strong>${importedCounts.added}</strong> new students and updated <strong>${importedCounts.updated}</strong> records.
            </p>
          </div>

          <div class="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3 text-left">
            <h4 class="text-xs font-semibold uppercase text-slate-500">Next Steps: Student Access Codes</h4>
            <p class="text-xs text-slate-600">
              Students need access codes to submit work securely and view their private grade reports.
            </p>
            <div class="flex flex-wrap gap-2">
              <sl-button size="small" variant="primary" id="btn-comp-generate-codes">
                <sl-icon slot="prefix" name="key"></sl-icon> Generate Missing Codes
              </sl-button>
              <sl-button size="small" variant="default" id="btn-comp-print-slips">
                <sl-icon slot="prefix" name="printer"></sl-icon> Print Code Slips
              </sl-button>
            </div>
          </div>
        </div>
        <div slot="footer" class="flex justify-end">
          <sl-button variant="primary" id="btn-comp-done">Done</sl-button>
        </div>
      `;

      dialog.querySelector('#btn-comp-generate-codes')?.addEventListener('click', async () => {
        await AccessCodes.ensureForCourse(course.id);
        toast.success('Generated access codes for students.');
      });

      dialog.querySelector('#btn-comp-print-slips')?.addEventListener('click', async () => {
        const students = await storage.table('gradebook_students').where('course_id').equals(course.id).toArray();
        AccessCodes.printSlips(students, course);
      });

      dialog.querySelector('#btn-comp-done')?.addEventListener('click', () => {
        dialog.hide();
      });
    }

    document.body.appendChild(dialog);
    render();
    dialog.show();

    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target === dialog) dialog.remove();
    });

    return dialog;
  }

  /**
   * Batch-provision multiple classes and their rosters from parsed OneRoster classes.
   * Creates or updates gradebook_courses, generates 8-char class codes, and enrolls students
   * with generated personal access codes.
   * @param {Array<{ sourcedId?: string, title: string, classCode?: string, schoolYear?: string, students: Array<object> }>} selectedClasses
   * @returns {Promise<{ createdCourses: number, updatedCourses: number, addedStudents: number }>}
   */
  static async importOneRosterClassesBatch(selectedClasses = []) {
    const { generateUUID } = await import('../utils/uuid.js');
    const existingCourses = await storage.table('gradebook_courses').toArray().catch(() => []);
    let createdCourses = 0;
    let updatedCourses = 0;
    let addedStudents = 0;

    for (const cls of selectedClasses) {
      if (!cls || !cls.title) continue;
      let course = existingCourses.find(c =>
        (cls.sourcedId && c.oneroster_sourced_id === cls.sourcedId) ||
        (c.name === cls.title && (c.section || '') === (cls.classCode || ''))
      );

      if (!course) {
        course = {
          id: generateUUID(),
          name: cls.title,
          section: cls.classCode || '',
          academic_year: cls.schoolYear || '2026-2027',
          oneroster_sourced_id: cls.sourcedId || null,
          access_code: AccessCodes.generateClassCode(),
          grading_scale: 'traditional',
          categories: [
            { id: 'cat-classwork', name: 'Classwork', weight_pct: 40 },
            { id: 'cat-assessments', name: 'Assessments', weight_pct: 60 }
          ],
          standards: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await storage.table('gradebook_courses').put(course);
        existingCourses.push(course);
        createdCourses++;
      } else {
        if (!course.access_code) course.access_code = AccessCodes.generateClassCode();
        if (cls.sourcedId && !course.oneroster_sourced_id) course.oneroster_sourced_id = cls.sourcedId;
        course.updated_at = new Date().toISOString();
        await storage.table('gradebook_courses').put(course);
        updatedCourses++;
      }

      const existingStudents = await storage.table('gradebook_students').where('course_id').equals(course.id).toArray().catch(() => []);
      const existingById = new Map(existingStudents.map(s => [String(s.student_id).toUpperCase(), s]));

      for (const st of cls.students || []) {
        const sid = String(st.student_id || st.sourced_id || '').trim();
        if (!sid) continue;
        const key = sid.toUpperCase();
        if (existingById.has(key)) continue;
        const fullName = [st.given_name, st.family_name].filter(Boolean).join(' ').trim() || st.full_name || sid;
        const newStudent = {
          id: generateUUID(),
          course_id: course.id,
          student_id: sid,
          given_name: st.given_name || '',
          family_name: st.family_name || '',
          full_name: fullName,
          email: st.email || '',
          access_code: AccessCodes.generateCode(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await storage.table('gradebook_students').put(newStudent);
        existingById.set(key, newStudent);
        addedStudents++;
      }
    }

    return { createdCourses, updatedCourses, addedStudents };
  }

  /**
   * Open a wizard to bulk-import multiple classes & rosters from a OneRoster ZIP archive.
   */
  static async openOneRosterBulkImportDialog({ onComplete } = {}) {
    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Bulk Import Classes (OneRoster ZIP)';
    dialog.style.setProperty('--width', '640px');
    let parsedClasses = [];

    const renderBody = () => {
      dialog.innerHTML = `
        <div class="space-y-4 text-sm">
          <p class="text-xs text-slate-600">Drop a OneRoster 1.1/1.2 <code>.zip</code> archive containing <code>classes.csv</code>, <code>users.csv</code>, and <code>enrollments.csv</code> to provision multiple classes and rosters at once.</p>
          <div class="border-2 border-dashed border-slate-300 rounded-xl p-6 text-center bg-slate-50 hover:border-primary-400 transition-colors cursor-pointer" id="bulk-or-drop">
            <input type="file" id="bulk-or-file" accept=".zip" class="hidden">
            <sl-icon name="file-earmark-zip" class="text-3xl text-primary-600 mb-1"></sl-icon>
            <div class="font-medium text-slate-800">Click to select OneRoster .zip</div>
            <div class="text-xs text-slate-500 mt-0.5">Generates 8-char class codes and student passcodes automatically</div>
          </div>
          ${parsedClasses.length ? `
            <div class="space-y-2">
              <div class="flex items-center justify-between text-xs font-semibold text-slate-700">
                <span>Found ${parsedClasses.length} class${parsedClasses.length === 1 ? '' : 'es'}</span>
                <label class="flex items-center gap-1.5 cursor-pointer font-normal">
                  <input type="checkbox" id="bulk-or-toggle-all" checked> Select All
                </label>
              </div>
              <div class="max-h-60 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white">
                ${parsedClasses.map((c, idx) => `
                  <label class="flex items-center justify-between p-3 hover:bg-slate-50 cursor-pointer text-xs">
                    <div class="flex items-center gap-2.5">
                      <input type="checkbox" class="bulk-or-cls-chk" data-idx="${idx}" checked>
                      <div>
                        <div class="font-semibold text-slate-900">${Sanitizer.escapeHTML(c.title)}</div>
                        <div class="text-slate-500">${c.classCode ? `Section ${Sanitizer.escapeHTML(c.classCode)} · ` : ''}${c.students.length} student${c.students.length === 1 ? '' : 's'}</div>
                      </div>
                    </div>
                  </label>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>
        <div slot="footer" class="flex justify-end gap-2">
          <sl-button variant="default" id="bulk-or-cancel">Cancel</sl-button>
          <sl-button variant="primary" id="bulk-or-import" ${parsedClasses.length ? '' : 'disabled'}>Import Selected Classes</sl-button>
        </div>
      `;

      const fileInput = dialog.querySelector('#bulk-or-file');
      dialog.querySelector('#bulk-or-drop')?.addEventListener('click', () => fileInput?.click());
      fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const res = await parseOneRosterBundle(file);
          parsedClasses = res.classes || [];
          if (!parsedClasses.length) toast.warning('No classes found in this OneRoster archive.');
          renderBody();
        } catch (err) {
          toast.error('Failed to parse OneRoster ZIP: ' + err.message);
        }
      });

      dialog.querySelector('#bulk-or-toggle-all')?.addEventListener('change', (e) => {
        const checked = e.target.checked;
        dialog.querySelectorAll('.bulk-or-cls-chk').forEach(chk => { chk.checked = checked; });
      });

      dialog.querySelector('#bulk-or-cancel')?.addEventListener('click', () => dialog.hide());
      dialog.querySelector('#bulk-or-import')?.addEventListener('click', async () => {
        const selected = [];
        dialog.querySelectorAll('.bulk-or-cls-chk').forEach(chk => {
          if (chk.checked) selected.push(parsedClasses[Number(chk.dataset.idx)]);
        });
        if (!selected.length) {
          toast.warning('Select at least one class to import.');
          return;
        }
        const btn = dialog.querySelector('#bulk-or-import');
        btn.loading = true;
        try {
          const summary = await RosterImportDialog.importOneRosterClassesBatch(selected);
          toast.success(`Imported ${summary.createdCourses} new and ${summary.updatedCourses} existing classes (${summary.addedStudents} students added).`);
          dialog.hide();
          if (onComplete) onComplete(summary);
        } catch (err) {
          toast.error('Bulk import failed: ' + err.message);
          btn.loading = false;
        }
      });
    };

    document.body.appendChild(dialog);
    renderBody();
    dialog.show();
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target === dialog) dialog.remove();
    });
    return dialog;
  }
}

export default RosterImportDialog;
