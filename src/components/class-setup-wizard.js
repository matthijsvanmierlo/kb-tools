import { storage } from '../core/storage.js';
import { generateUUID } from '../utils/uuid.js';
import { toast } from '../utils/toast.js';
import { Sanitizer } from '../core/sanitizer.js';
import { defaultAcademicYear } from '../core/academic-year.js';
import { ClassManager, CLASS_COLOR_PRESETS } from './class-manager.js';
import { applyGradingTemplate, parsePastedRoster, detectColumns, normalizeRows } from '../core/roster-import.js';
import { AccessCodes } from '../core/access-codes.js';

export class ClassSetupWizard {
  /**
   * Open the multi-step class setup wizard
   * @param {object} [opts]
   * @param {Function} [opts.onDone] - Callback invoked when class creation is completed
   * @returns {HTMLElement} The created sl-dialog element
   */
  static async open({ onDone } = {}) {
    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Create New Class';
    dialog.style.setProperty('--width', '620px');
    dialog.className = 'kb-class-setup-wizard';

    const existingClasses = await ClassManager.getClasses({ includeArchived: false });

    // Wizard state
    let currentStep = 1; // 1: Class, 2: Students, 3: Grading, 4: Access Codes, 5: Finish
    const courseData = {
      name: '',
      section: 'Period 1',
      academic_year: defaultAcademicYear(),
      color: CLASS_COLOR_PRESETS[0].color
    };
    let stagedStudents = [];
    let gradingTemplate = 'points_two_categories';
    let copySourceId = existingClasses.length > 0 ? existingClasses[0].id : null;
    let generateCodes = true;
    let createdCourse = null;

    const render = () => {
      dialog.label = currentStep === 5 ? 'Class Created!' : `Create New Class — Step ${currentStep} of 4`;

      if (currentStep === 1) renderStep1();
      else if (currentStep === 2) renderStep2();
      else if (currentStep === 3) renderStep3();
      else if (currentStep === 4) renderStep4();
      else if (currentStep === 5) renderStep5();
    };

    function renderProgressBar() {
      if (currentStep === 5) return '';
      const steps = ['Class Details', 'Students', 'Grading Mode', 'Access Codes'];
      return `
        <div class="flex items-center justify-between mb-4 px-1 text-xs text-slate-500 border-b pb-3">
          ${steps.map((label, idx) => {
            const stepNum = idx + 1;
            const isDone = currentStep > stepNum;
            const isCurrent = currentStep === stepNum;
            return `
              <div class="flex items-center gap-1.5 ${isCurrent ? 'font-bold text-blue-600' : (isDone ? 'text-slate-800' : 'text-slate-400')}">
                <span class="w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${isCurrent ? 'bg-blue-600 text-white' : (isDone ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600')}">
                  ${isDone ? '✓' : stepNum}
                </span>
                <span class="hidden sm:inline">${label}</span>
              </div>
            `;
          }).join('<span class="text-slate-300">›</span>')}
        </div>
      `;
    }

    // Step 1: Class Details
    function renderStep1() {
      dialog.innerHTML = `
        <div class="py-1 text-sm">
          ${renderProgressBar()}
          <div class="space-y-4">
            <sl-input id="wiz-class-name" label="Class / Course Name" placeholder="e.g. AP Chemistry" value="${Sanitizer.escapeHTML(courseData.name)}" required autofocus></sl-input>

            <div class="grid grid-cols-2 gap-3">
              <sl-input id="wiz-class-section" label="Section / Period" placeholder="e.g. Period 2" value="${Sanitizer.escapeHTML(courseData.section)}"></sl-input>
              <sl-input id="wiz-class-year" label="Academic Year" placeholder="e.g. 2026-2027" value="${Sanitizer.escapeHTML(courseData.academic_year)}"></sl-input>
            </div>

            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-2">Class Theme Color</label>
              <div class="grid grid-cols-4 gap-2" id="wiz-color-picker">
                ${CLASS_COLOR_PRESETS.map(p => `
                  <button type="button" class="wiz-color-swatch flex items-center gap-1.5 p-2 rounded-lg border text-xs font-medium transition-all ${p.color.toLowerCase() === courseData.color.toLowerCase() ? 'ring-2 ring-blue-500 border-blue-500 font-bold' : 'border-slate-200 hover:border-slate-300'}" data-color="${p.color}" style="background-color: ${p.bg}; color: ${p.text};">
                    <span class="w-3 h-3 rounded-full" style="background-color: ${p.color};"></span>
                    <span>${p.name}</span>
                  </button>
                `).join('')}
              </div>
            </div>
          </div>
        </div>
        <div slot="footer" class="flex justify-between items-center w-full">
          <sl-button variant="default" id="wiz-btn-cancel">Cancel</sl-button>
          <sl-button variant="primary" id="wiz-btn-step1-next">Next: Students <sl-icon slot="suffix" name="arrow-right"></sl-icon></sl-button>
        </div>
      `;

      dialog.querySelector('#wiz-btn-cancel')?.addEventListener('click', () => dialog.hide());

      dialog.querySelectorAll('.wiz-color-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
          courseData.color = btn.dataset.color;
          dialog.querySelectorAll('.wiz-color-swatch').forEach(b => {
            if (b.dataset.color === courseData.color) {
              b.classList.add('ring-2', 'ring-blue-500', 'border-blue-500', 'font-bold');
            } else {
              b.classList.remove('ring-2', 'ring-blue-500', 'border-blue-500', 'font-bold');
            }
          });
        });
      });

      dialog.querySelector('#wiz-btn-step1-next')?.addEventListener('click', () => {
        const nameInput = dialog.querySelector('#wiz-class-name');
        const sectionInput = dialog.querySelector('#wiz-class-section');
        const yearInput = dialog.querySelector('#wiz-class-year');

        const nameVal = nameInput?.value?.trim();
        if (!nameVal) {
          toast.danger('Please provide a class name.');
          nameInput?.focus();
          return;
        }

        courseData.name = nameVal;
        courseData.section = sectionInput?.value?.trim() || 'Period 1';
        courseData.academic_year = yearInput?.value?.trim() || defaultAcademicYear();

        currentStep = 2;
        render();
      });
    }

    // Step 2: Students
    function renderStep2() {
      dialog.innerHTML = `
        <div class="py-1 text-sm">
          ${renderProgressBar()}
          <div class="space-y-4">
            <div>
              <h3 class="font-semibold text-slate-800">Add Students to Roster</h3>
              <p class="text-xs text-slate-500">Paste your roster from Google Sheets/Excel, or skip and add students later.</p>
            </div>

            <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
              <sl-textarea id="wiz-roster-paste" rows="5" placeholder="StudentID&#9;Full Name&#9;Email&#10;S101&#9;Emma Watson&#9;emma@school.org"></sl-textarea>
              <div class="flex items-center justify-between">
                <span class="text-xs text-slate-500" id="wiz-staged-status">
                  ${stagedStudents.length > 0 ? `<strong>${stagedStudents.length}</strong> students ready to add.` : 'No students staged.'}
                </span>
                <sl-button size="small" variant="default" id="wiz-btn-parse-students">
                  <sl-icon slot="prefix" name="check2"></sl-icon> Parse Roster
                </sl-button>
              </div>
            </div>

            <div class="text-xs text-slate-500 text-center">
              You can also import OneRoster or CSV files anytime via the Gradebook Roster view.
            </div>
          </div>
        </div>
        <div slot="footer" class="flex justify-between items-center w-full">
          <sl-button variant="default" id="wiz-btn-step2-back">
            <sl-icon slot="prefix" name="arrow-left"></sl-icon> Back
          </sl-button>
          <div class="flex gap-2">
            <sl-button variant="default" id="wiz-btn-step2-skip">Add Later</sl-button>
            <sl-button variant="primary" id="wiz-btn-step2-next">
              Next: Grading <sl-icon slot="suffix" name="arrow-right"></sl-icon>
            </sl-button>
          </div>
        </div>
      `;

      dialog.querySelector('#wiz-btn-step2-back')?.addEventListener('click', () => {
        currentStep = 1;
        render();
      });

      const parseStudents = () => {
        const text = dialog.querySelector('#wiz-roster-paste')?.value?.trim();
        if (!text) return false;
        const parsed = parsePastedRoster(text);
        if (parsed.fields.length && parsed.rows.length) {
          const detected = detectColumns(parsed.fields);
          // If no student ID detected, fallback to email if present
          if (!detected.mapping.student_id && detected.mapping.email) {
            detected.mapping.student_id = '__email__';
          }
          const normalized = normalizeRows(parsed.rows, detected.mapping);
          stagedStudents = normalized.filter(s => s && !s.errors && s.student_id);
          const statusEl = dialog.querySelector('#wiz-staged-status');
          if (statusEl) {
            statusEl.innerHTML = `<strong>${stagedStudents.length}</strong> students ready to add.`;
          }
          toast.success(`Parsed ${stagedStudents.length} students.`);
          return true;
        }
        return false;
      };

      dialog.querySelector('#wiz-btn-parse-students')?.addEventListener('click', parseStudents);

      dialog.querySelector('#wiz-btn-step2-skip')?.addEventListener('click', () => {
        stagedStudents = [];
        currentStep = 3;
        render();
      });

      dialog.querySelector('#wiz-btn-step2-next')?.addEventListener('click', () => {
        const text = dialog.querySelector('#wiz-roster-paste')?.value?.trim();
        if (text && stagedStudents.length === 0) {
          parseStudents();
        }
        currentStep = 3;
        render();
      });
    }

    // Step 3: Grading Mode
    function renderStep3() {
      dialog.innerHTML = `
        <div class="py-1 text-sm">
          ${renderProgressBar()}
          <div class="space-y-4">
            <div>
              <h3 class="font-semibold text-slate-800">Choose Grading Structure</h3>
              <p class="text-xs text-slate-500">Pick a starting grading template. You can fine-tune all settings later.</p>
            </div>

            <div class="space-y-2.5">
              <label class="flex items-start gap-3 p-3 rounded-xl border border-slate-200 hover:border-blue-400 cursor-pointer bg-white transition-colors">
                <input type="radio" name="wiz-grading-mode" value="points_two_categories" ${gradingTemplate === 'points_two_categories' ? 'checked' : ''} class="mt-1">
                <div>
                  <span class="block font-semibold text-slate-800">Points, Two Categories (Recommended)</span>
                  <span class="text-xs text-slate-500">Assessments (60%) and Classwork &amp; Homework (40%). Traditional weighted points model.</span>
                </div>
              </label>

              <label class="flex items-start gap-3 p-3 rounded-xl border border-slate-200 hover:border-blue-400 cursor-pointer bg-white transition-colors">
                <input type="radio" name="wiz-grading-mode" value="points_single_category" ${gradingTemplate === 'points_single_category' ? 'checked' : ''} class="mt-1">
                <div>
                  <span class="block font-semibold text-slate-800">Points, Single Category</span>
                  <span class="text-xs text-slate-500">Single category (100% All Work). Simple points accumulative grading.</span>
                </div>
              </label>

              <label class="flex items-start gap-3 p-3 rounded-xl border border-slate-200 hover:border-blue-400 cursor-pointer bg-white transition-colors">
                <input type="radio" name="wiz-grading-mode" value="sbg" ${gradingTemplate === 'sbg' ? 'checked' : ''} class="mt-1">
                <div>
                  <span class="block font-semibold text-slate-800">Standards-Based Grading (SBG)</span>
                  <span class="text-xs text-slate-500">4-level mastery scale (4: Advanced, 3: Proficient, 2: Developing, 1: Beginning) with decay calculation.</span>
                </div>
              </label>

              ${existingClasses.length > 0 ? `
                <label class="flex items-start gap-3 p-3 rounded-xl border border-slate-200 hover:border-blue-400 cursor-pointer bg-white transition-colors">
                  <input type="radio" name="wiz-grading-mode" value="copy" ${gradingTemplate === 'copy' ? 'checked' : ''} class="mt-1">
                  <div class="flex-1">
                    <span class="block font-semibold text-slate-800">Copy Structure from Existing Class</span>
                    <span class="text-xs text-slate-500 block mb-2">Copies terms, categories, grading scale, rubrics, and policies.</span>
                    <sl-select size="small" id="wiz-select-copy-course" value="${copySourceId}" class="w-full">
                      ${existingClasses.map(c => `
                        <sl-option value="${c.id}">${Sanitizer.escapeHTML(c.name)}${c.section ? ` (${Sanitizer.escapeHTML(c.section)})` : ''}</sl-option>
                      `).join('')}
                    </sl-select>
                  </div>
                </label>
              ` : ''}
            </div>

            <p class="text-xs text-slate-400 text-center">
              Fine-tune categories, scales, and late policies later in Class Settings.
            </p>
          </div>
        </div>
        <div slot="footer" class="flex justify-between items-center w-full">
          <sl-button variant="default" id="wiz-btn-step3-back">
            <sl-icon slot="prefix" name="arrow-left"></sl-icon> Back
          </sl-button>
          <sl-button variant="primary" id="wiz-btn-step3-next">
            Next: Access Codes <sl-icon slot="suffix" name="arrow-right"></sl-icon>
          </sl-button>
        </div>
      `;

      dialog.querySelector('#wiz-btn-step3-back')?.addEventListener('click', () => {
        currentStep = 2;
        render();
      });

      dialog.querySelectorAll('input[name="wiz-grading-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
          gradingTemplate = e.target.value;
        });
      });

      const copySelect = dialog.querySelector('#wiz-select-copy-course');
      copySelect?.addEventListener('sl-change', () => {
        copySourceId = copySelect.value;
      });

      dialog.querySelector('#wiz-btn-step3-next')?.addEventListener('click', () => {
        currentStep = 4;
        render();
      });
    }

    // Step 4: Access Codes & Confirm
    function renderStep4() {
      dialog.innerHTML = `
        <div class="py-1 text-sm">
          ${renderProgressBar()}
          <div class="space-y-4">
            <div>
              <h3 class="font-semibold text-slate-800">Security &amp; Access Codes</h3>
              <p class="text-xs text-slate-500">Keep student records private and verify hand-in authenticity.</p>
            </div>

            <div class="p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
              <label class="flex items-start gap-2.5 cursor-pointer font-medium text-slate-800">
                <input type="checkbox" id="wiz-chk-codes" ${generateCodes ? 'checked' : ''} class="mt-0.5 rounded border-slate-300">
                <span>Generate access codes for enrolled students now</span>
              </label>
              <p class="text-xs text-slate-600 leading-relaxed">
                Access codes are private credentials issued to each student. They unlock encrypted grade reports and sign assignment receipts. Without an access code, students can only view reports using their student ID, which classmates might guess.
              </p>
            </div>

            <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 space-y-1">
              <div class="font-semibold text-slate-800">Class Summary:</div>
              <div>• Name: <strong>${Sanitizer.escapeHTML(courseData.name)}</strong> (${Sanitizer.escapeHTML(courseData.section)})</div>
              <div>• Academic Year: ${Sanitizer.escapeHTML(courseData.academic_year)}</div>
              <div>• Initial Roster: <strong>${stagedStudents.length}</strong> students</div>
              <div>• Grading Model: ${gradingTemplate === 'sbg' ? 'Standards-Based' : (gradingTemplate === 'points_single_category' ? 'Single Category' : (gradingTemplate === 'copy' ? 'Copied' : 'Two Categories'))}</div>
            </div>
          </div>
        </div>
        <div slot="footer" class="flex justify-between items-center w-full">
          <sl-button variant="default" id="wiz-btn-step4-back">
            <sl-icon slot="prefix" name="arrow-left"></sl-icon> Back
          </sl-button>
          <sl-button variant="primary" id="wiz-btn-create-class">
            <sl-icon slot="prefix" name="check-lg"></sl-icon> Create Class
          </sl-button>
        </div>
      `;

      dialog.querySelector('#wiz-btn-step4-back')?.addEventListener('click', () => {
        currentStep = 3;
        render();
      });

      dialog.querySelector('#wiz-chk-codes')?.addEventListener('change', (e) => {
        generateCodes = e.target.checked;
      });

      dialog.querySelector('#wiz-btn-create-class')?.addEventListener('click', async () => {
        await executeClassCreation();
      });
    }

    async function executeClassCreation() {
      try {
        let sourceCourse = null;
        if (gradingTemplate === 'copy' && copySourceId) {
          sourceCourse = await ClassManager.getClass(copySourceId);
        }

        // Prepare initial course object
        const newCourseId = generateUUID();
        const baseCourse = {
          id: newCourseId,
          name: courseData.name,
          section: courseData.section,
          academic_year: courseData.academic_year,
          color: courseData.color
        };

        const templatedCourse = applyGradingTemplate(baseCourse, gradingTemplate, sourceCourse);

        // Save course
        createdCourse = await ClassManager.saveClass(templatedCourse, templatedCourse);

        // If copy mode, also duplicate source course rubrics
        if (sourceCourse) {
          const rubrics = await storage.table('gradebook_rubrics').where('course_id').equals(sourceCourse.id).toArray();
          for (const rub of rubrics) {
            const copyRubric = { ...rub, id: generateUUID(), course_id: createdCourse.id };
            await storage.table('gradebook_rubrics').put(copyRubric);
          }
        }

        // Save staged students
        if (stagedStudents.length > 0) {
          const now = new Date().toISOString();
          const studentsTable = storage.table('gradebook_students');
          for (const s of stagedStudents) {
            await studentsTable.put({
              id: generateUUID(),
              course_id: createdCourse.id,
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

          if (generateCodes) {
            await AccessCodes.ensureForCourse(createdCourse.id);
          }
        }

        toast.success(`Class "${Sanitizer.escapeHTML(createdCourse.name)}" created!`);
        currentStep = 5;
        render();
        if (onDone) onDone(createdCourse);
      } catch (err) {
        toast.danger(`Error creating class: ${err.message}`);
      }
    }

    // Step 5: Finish Screen
    function renderStep5() {
      dialog.innerHTML = `
        <div class="py-6 text-center space-y-4">
          <div class="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto text-3xl">
            <sl-icon name="check2-circle"></sl-icon>
          </div>
          <div>
            <h3 class="text-xl font-bold text-slate-800">You're All Set!</h3>
            <p class="text-sm text-slate-500 mt-1">
              Class <strong>${Sanitizer.escapeHTML(createdCourse?.name || '')}</strong> is ready.
            </p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-md mx-auto pt-2 text-left">
            <sl-button variant="primary" class="w-full" id="wiz-btn-finish-gradebook">
              <sl-icon slot="prefix" name="journal-bookmark"></sl-icon> Open Gradebook
            </sl-button>
            <sl-button variant="default" class="w-full" id="wiz-btn-finish-assignment">
              <sl-icon slot="prefix" name="clipboard-check"></sl-icon> Create Assignment
            </sl-button>
            ${stagedStudents.length > 0 && generateCodes ? `
              <sl-button variant="default" class="w-full" id="wiz-btn-finish-print-slips">
                <sl-icon slot="prefix" name="printer"></sl-icon> Print Code Slips
              </sl-button>
              <sl-button variant="default" class="w-full" id="wiz-btn-finish-export-codes">
                <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Export Codes CSV
              </sl-button>
            ` : ''}
          </div>
        </div>
        <div slot="footer" class="flex justify-end">
          <sl-button variant="default" id="wiz-btn-finish-close">Close</sl-button>
        </div>
      `;

      dialog.querySelector('#wiz-btn-finish-close')?.addEventListener('click', () => dialog.hide());

      dialog.querySelector('#wiz-btn-finish-gradebook')?.addEventListener('click', () => {
        ClassManager.setActiveFilter(createdCourse.id);
        window.location.hash = `#/gradebook?courseId=${createdCourse.id}`;
        dialog.hide();
      });

      dialog.querySelector('#wiz-btn-finish-assignment')?.addEventListener('click', () => {
        window.location.hash = '#/assignments';
        dialog.hide();
      });

      dialog.querySelector('#wiz-btn-finish-print-slips')?.addEventListener('click', async () => {
        const students = await storage.table('gradebook_students').where('course_id').equals(createdCourse.id).toArray();
        AccessCodes.printSlips(students, createdCourse);
      });

      dialog.querySelector('#wiz-btn-finish-export-codes')?.addEventListener('click', async () => {
        const students = await storage.table('gradebook_students').where('course_id').equals(createdCourse.id).toArray();
        const csvText = AccessCodes.toCSV(students, createdCourse);
        const blob = new Blob([csvText], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${createdCourse.name.replace(/[^a-z0-9]+/gi, '_')}_access_codes.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 500);
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
}

export default ClassSetupWizard;
