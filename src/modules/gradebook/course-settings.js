import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { AccessCodes, generateAccessCode, MIN_ACCESS_CODE_LENGTH } from '../../core/access-codes.js';
import {
  LETTER_SCALE_PRESETS,
  SBG_CALCULATION_METHODS,
  STANDARD_SET_PRESETS,
  getLetterScale,
  getSbgConfig,
  getStandards,
  letterForPercent,
  parseStandardsText
} from './grading-scales.js';
import { STANDARDS_CSV_TEMPLATE, downloadCSVTemplate } from '../../core/csv-templates.js';
import { downloadCSV } from '../../core/csv.js';

/**
 * Class Settings (KB-GRAD-008)
 * Tabbed editor for everything that belongs to one class section:
 * general info, category weights & late/missing policies, the letter-grade scale,
 * standards-based grading (proficiency scale, calculation, conversion, standards list),
 * and student access codes.
 */

const esc = (v) => Sanitizer.escapeHTML(v ?? '');
const clone = (v) => JSON.parse(JSON.stringify(v));

const LATE_MODES = {
  none: 'No automatic penalty',
  fixed: 'Flat deduction',
  daily: 'Deduction per day late'
};

export function openCourseSettingsDialog({ course, otherCourses = [], initialTab = 'general', onSave, onAccessChanged }) {
  const draft = clone(course);
  draft.categories = draft.categories || [];
  draft.terms = draft.terms || [];
  draft.letter_scale = clone(getLetterScale(draft));
  draft.sbg = clone(getSbgConfig(draft));
  draft.standards = clone(getStandards(draft));

  let activeTab = initialTab;
  let students = [];
  let revealCodes = false;
  let accessChanged = false;
  let savedSettings = false;

  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Class settings';
  dialog.style.setProperty('--width', 'min(820px, 96vw)');
  dialog.classList.add('kb-settings-dialog');

  const sectionCard = (inner, extra = '') => `<div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3 ${extra}">${inner}</div>`;
  const helper = (text) => `<p class="text-xs text-slate-500 leading-relaxed">${text}</p>`;

  // ---------------------------------------------------------------------------
  // Tab panels
  // ---------------------------------------------------------------------------
  const generalPanel = () => `
    <div class="space-y-4">
      <div class="grid grid-cols-1 sm:grid-cols-12 gap-4">
        <sl-input class="sm:col-span-6" id="cs-name" label="Class name" value="${esc(draft.name)}" required></sl-input>
        <sl-input class="sm:col-span-3" id="cs-section" label="Section / period" value="${esc(draft.section)}"></sl-input>
        <sl-input class="sm:col-span-3" id="cs-year" label="Academic year" value="${esc(draft.academic_year || '2026-2027')}"></sl-input>
      </div>
      ${sectionCard(`
        <div class="flex items-center justify-between">
          <h4 class="text-sm font-semibold text-slate-900">Terms</h4>
          <sl-button size="small" id="cs-add-term"><sl-icon slot="prefix" name="plus-lg"></sl-icon> Add term</sl-button>
        </div>
        <div class="space-y-2">
          ${draft.terms.map((t, i) => `
            <div class="flex items-center gap-2">
              <sl-input size="small" class="cs-term-name flex-1" data-i="${i}" value="${esc(t.name)}" aria-label="Term name"></sl-input>
              <button type="button" class="kb-icon-btn hover:!text-red-600 cs-del-term" data-i="${i}" aria-label="Remove term"><sl-icon name="trash"></sl-icon></button>
            </div>`).join('') || helper('No terms yet.')}
        </div>
      `)}
      ${sectionCard(`
        <h4 class="text-sm font-semibold text-slate-900">Grading mode</h4>
        <sl-radio-group id="cs-mode" value="${draft.grading_scale === 'sbg' ? 'sbg' : 'traditional'}">
          <sl-radio-button value="traditional">Points &amp; percentages</sl-radio-button>
          <sl-radio-button value="sbg">Standards-based</sl-radio-button>
        </sl-radio-group>
        ${helper('Points mode averages weighted categories into a percentage. Standards-based mode reports mastery per standard and converts it to an overall grade on the Standards tab.')}
      `)}
    </div>`;

  const categoriesPanel = () => {
    const total = draft.categories.reduce((s, c) => s + (Number(c.weight_pct) || 0), 0);
    return `
      <div class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold px-2 py-1 rounded-md tabular-nums ${total === 100 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}">
            Weights total ${esc(total)}%${total === 100 ? ' ✓' : ' — should add up to 100%'}
          </span>
          <sl-button size="small" id="cs-add-cat"><sl-icon slot="prefix" name="plus-lg"></sl-icon> Add category</sl-button>
        </div>
        ${draft.categories.map((c, i) => {
          const p = c.policy || {};
          const mode = p.late_mode || 'none';
          return sectionCard(`
            <div class="flex items-end gap-2">
              <sl-input size="small" class="cs-cat flex-1" data-i="${i}" data-f="name" label="Category" value="${esc(c.name)}"></sl-input>
              <sl-input size="small" type="number" class="cs-cat w-24" data-i="${i}" data-f="weight_pct" label="Weight %" value="${esc(c.weight_pct ?? 0)}"></sl-input>
              <sl-input size="small" type="number" class="cs-cat w-28" data-i="${i}" data-f="drop_lowest" label="Drop lowest" value="${esc(c.drop_lowest ?? 0)}" min="0"></sl-input>
              <button type="button" class="kb-icon-btn hover:!text-red-600 cs-del-cat mb-0.5" data-i="${i}" aria-label="Remove category"><sl-icon name="trash"></sl-icon></button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-1 border-t border-slate-100">
              <sl-select size="small" class="cs-pol sm:col-span-2" data-i="${i}" data-f="late_mode" label="Late work" value="${esc(mode)}">
                ${Object.entries(LATE_MODES).map(([k, v]) => `<sl-option value="${k}">${v}</sl-option>`).join('')}
              </sl-select>
              ${mode === 'fixed' ? `
                <sl-input size="small" type="number" class="cs-pol" data-i="${i}" data-f="late_deduct_pct" label="Deduct %" value="${esc(p.late_deduct_pct ?? 10)}"></sl-input>
              ` : mode === 'daily' ? `
                <sl-input size="small" type="number" class="cs-pol" data-i="${i}" data-f="late_daily_pct" label="% per day" value="${esc(p.late_daily_pct ?? 5)}"></sl-input>
                <sl-input size="small" type="number" class="cs-pol" data-i="${i}" data-f="max_late_cap_pct" label="Max penalty %" value="${esc(p.max_late_cap_pct ?? 50)}"></sl-input>
              ` : '<div class="hidden sm:block"></div>'}
              <sl-input size="small" type="number" class="cs-pol ${mode === 'daily' ? 'sm:col-span-4' : ''}" data-i="${i}" data-f="missing_floor_pct" label="Missing counts as %" value="${esc(p.missing_floor_pct ?? 0)}"></sl-input>
            </div>
          `);
        }).join('')}
        ${helper('Penalties are applied when averages are calculated; the score you type is always kept. Excused work is never counted.')}
      </div>`;
  };

  const scalePanel = () => {
    const bands = [...draft.letter_scale.bands].sort((a, b) => b.min - a.min);
    const samples = [97, 91, 85, 78, 72, 64, 50];
    return `
      <div class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <sl-select id="cs-scale-preset" label="Start from a preset" value="${esc(draft.letter_scale.preset || 'custom')}">
            ${Object.entries(LETTER_SCALE_PRESETS).map(([k, v]) => `<sl-option value="${k}">${esc(v.name)}</sl-option>`).join('')}
            <sl-option value="custom">Custom</sl-option>
          </sl-select>
          <sl-select id="cs-scale-copy" label="Copy from another class" placeholder="${otherCourses.length ? 'Choose a class…' : 'No other classes yet'}" ${otherCourses.length ? '' : 'disabled'}>
            ${otherCourses.map(c => `<sl-option value="${esc(c.id)}">${esc(c.name)}${c.section ? ` · ${esc(c.section)}` : ''}</sl-option>`).join('')}
          </sl-select>
        </div>
        ${sectionCard(`
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-semibold text-slate-900">Grade bands</h4>
            <sl-button size="small" id="cs-add-band"><sl-icon slot="prefix" name="plus-lg"></sl-icon> Add band</sl-button>
          </div>
          <div class="grid grid-cols-[1fr_1fr_auto] gap-x-3 gap-y-2 items-center text-xs font-semibold text-slate-500">
            <span>Grade</span><span>Minimum %</span><span></span>
            ${bands.map(b => {
              const idx = draft.letter_scale.bands.indexOf(b);
              return `
                <sl-input size="small" class="cs-band" data-i="${idx}" data-f="label" value="${esc(b.label)}" aria-label="Grade label"></sl-input>
                <sl-input size="small" type="number" class="cs-band" data-i="${idx}" data-f="min" value="${esc(b.min)}" aria-label="Minimum percent"></sl-input>
                <button type="button" class="kb-icon-btn hover:!text-red-600 cs-del-band" data-i="${idx}" aria-label="Remove band"><sl-icon name="x-lg"></sl-icon></button>`;
            }).join('')}
          </div>
        `)}
        <div class="flex flex-wrap gap-2 text-xs" id="cs-scale-preview">
          ${samples.map(p => `<span class="px-2 py-1 rounded-md bg-slate-100 text-slate-600 tabular-nums">${p}% → <strong class="text-slate-900">${esc(letterForPercent(p, bands))}</strong></span>`).join('')}
        </div>
        ${helper('Each class section keeps its own scale, so two sections of the same course can map numbers to letters differently. In standards-based mode, the conversion on the Standards tab is used instead.')}
      </div>`;
  };

  const standardsPanel = () => {
    const sbg = draft.sbg;
    const levels = [...sbg.levels].sort((a, b) => b.value - a.value);
    const mbands = [...sbg.mastery_bands].sort((a, b) => b.min - a.min);
    return `
      <div class="space-y-4">
        ${sectionCard(`
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h4 class="text-sm font-semibold text-slate-900">Standards <span class="text-slate-400 font-medium">(${draft.standards.length})</span></h4>
            <div class="flex flex-wrap gap-2">
              <sl-dropdown hoist>
                <sl-button size="small" slot="trigger" caret><sl-icon slot="prefix" name="journal-arrow-down"></sl-icon> Import set</sl-button>
                <sl-menu id="cs-std-presets">
                  <sl-menu-label>Official standard sets</sl-menu-label>
                  ${STANDARD_SET_PRESETS.map(p => `<sl-menu-item value="${p.key}">${esc(p.name)}<div class="text-[11px] text-slate-400">${esc(p.subject)} · ${p.standards.length} standards</div></sl-menu-item>`).join('')}
                  <sl-divider></sl-divider>
                  <sl-menu-item value="__paste"><sl-icon slot="prefix" name="clipboard"></sl-icon> Paste a list…</sl-menu-item>
                  <sl-menu-item value="__csv"><sl-icon slot="prefix" name="filetype-csv"></sl-icon> Upload CSV…</sl-menu-item>
                  <sl-menu-item value="__template"><sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Download CSV Template</sl-menu-item>
                </sl-menu>
              </sl-dropdown>
              <sl-button size="small" id="cs-add-std"><sl-icon slot="prefix" name="plus-lg"></sl-icon> Add</sl-button>
              <input type="file" id="cs-std-csv" accept=".csv,.txt,.tsv" class="hidden" />
            </div>
          </div>
          <div class="space-y-2 max-h-72 overflow-y-auto pr-1">
            ${draft.standards.map((s, i) => `
              <div class="flex items-start gap-2">
                <sl-input size="small" class="cs-std w-36 flex-shrink-0" data-i="${i}" data-f="code" value="${esc(s.code)}" aria-label="Standard code"></sl-input>
                <sl-textarea size="small" rows="2" class="cs-std flex-1" data-i="${i}" data-f="description" value="${esc(s.description)}" aria-label="Standard description"></sl-textarea>
                <button type="button" class="kb-icon-btn hover:!text-red-600 cs-del-std" data-i="${i}" aria-label="Remove standard"><sl-icon name="trash"></sl-icon></button>
              </div>`).join('') || `
              <div class="text-center py-6 text-sm text-slate-500">
                <sl-icon name="bullseye" class="text-2xl text-slate-300"></sl-icon>
                <p class="mt-1">No standards yet. Import an official set, paste your own, or upload a CSV with <code>code, description</code> columns.</p>
              </div>`}
          </div>
          ${helper('Align assignments to standards in each assignment\'s settings. Proficiency scores then roll up into mastery per standard.')}
        `)}

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          ${sectionCard(`
            <h4 class="text-sm font-semibold text-slate-900">Proficiency scale</h4>
            <div class="space-y-2">
              ${levels.map(l => {
                const idx = sbg.levels.indexOf(l);
                return `
                  <div class="flex items-center gap-2">
                    <input type="color" class="cs-lvl w-8 h-8 rounded-md border border-slate-200 bg-transparent cursor-pointer flex-shrink-0" data-i="${idx}" data-f="color" value="${esc(l.color || '#64748b')}" aria-label="Level ${esc(l.value)} colour" />
                    <span class="w-6 text-center text-sm font-bold tabular-nums text-slate-700">${esc(l.value)}</span>
                    <sl-input size="small" class="cs-lvl flex-1 min-w-0" data-i="${idx}" data-f="label" value="${esc(l.label)}" aria-label="Level ${esc(l.value)} label"></sl-input>
                  </div>`;
              }).join('')}
            </div>
            <sl-switch id="cs-include-zero" ${sbg.levels.some(l => Number(l.value) === 0) ? 'checked' : ''} size="small">Include a 0 level (“No evidence”)</sl-switch>
          `)}
          ${sectionCard(`
            <h4 class="text-sm font-semibold text-slate-900">Mastery calculation</h4>
            <sl-select id="cs-calc" value="${esc(sbg.calculation)}" size="small">
              ${Object.entries(SBG_CALCULATION_METHODS).map(([k, v]) => `<sl-option value="${k}">${esc(v.name)}</sl-option>`).join('')}
            </sl-select>
            ${helper(esc(SBG_CALCULATION_METHODS[sbg.calculation]?.help || ''))}
            ${sbg.calculation === 'decaying_average' ? `
              <sl-input size="small" type="number" step="0.05" min="0.05" max="0.95" id="cs-decay" label="Weight of the newest score" value="${esc(sbg.decay_weight)}"></sl-input>
            ` : ''}
          `)}
        </div>

        ${sectionCard(`
          <div class="flex items-center justify-between">
            <h4 class="text-sm font-semibold text-slate-900">Mastery → report card grade</h4>
            <sl-button size="small" id="cs-add-mband"><sl-icon slot="prefix" name="plus-lg"></sl-icon> Add row</sl-button>
          </div>
          <div class="grid grid-cols-[1fr_1fr_1fr_auto] gap-x-3 gap-y-2 items-center text-xs font-semibold text-slate-500">
            <span>Average mastery ≥</span><span>Letter</span><span>Reported %</span><span></span>
            ${mbands.map(b => {
              const idx = sbg.mastery_bands.indexOf(b);
              return `
                <sl-input size="small" type="number" step="0.1" class="cs-mband" data-i="${idx}" data-f="min" value="${esc(b.min)}" aria-label="Minimum mastery"></sl-input>
                <sl-input size="small" class="cs-mband" data-i="${idx}" data-f="letter" value="${esc(b.letter)}" aria-label="Letter"></sl-input>
                <sl-input size="small" type="number" class="cs-mband" data-i="${idx}" data-f="percent" value="${esc(b.percent)}" aria-label="Reported percent"></sl-input>
                <button type="button" class="kb-icon-btn hover:!text-red-600 cs-del-mband" data-i="${idx}" aria-label="Remove row"><sl-icon name="x-lg"></sl-icon></button>`;
            }).join('')}
          </div>
          ${helper('The overall grade is the average of current mastery across all standards with evidence.')}
        `)}
      </div>`;
  };

  const accessPanel = () => {
    const missing = students.filter(s => !s.access_code).length;
    return `
      <div class="space-y-4">
        <div class="rounded-xl border border-blue-200 bg-blue-50 p-4 flex gap-3">
          <sl-icon name="key" class="text-blue-600 text-xl flex-shrink-0 mt-0.5"></sl-icon>
          <div class="text-sm text-slate-700 space-y-1">
            <p class="font-semibold text-slate-900">Each student gets a private access code</p>
            <p class="text-xs leading-relaxed">Students use it to unlock their encrypted grade report and to sign their assignment submissions, so nobody can open another student's grades or hand in work under their name. Share codes privately (printed slips, LMS private message). Changes on this tab save immediately.</p>
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs ${missing ? 'text-amber-700' : 'text-slate-500'}">${missing ? `${missing} student${missing === 1 ? '' : 's'} without a code — their links fall back to the student ID.` : `${students.length} student${students.length === 1 ? '' : 's'}, all with codes.`}</span>
          <div class="flex flex-wrap gap-2">
            <sl-button size="small" id="cs-codes-reveal"><sl-icon slot="prefix" name="${revealCodes ? 'eye-slash' : 'eye'}"></sl-icon> ${revealCodes ? 'Hide' : 'Show'} codes</sl-button>
            ${missing ? `<sl-button size="small" variant="primary" id="cs-codes-generate"><sl-icon slot="prefix" name="magic"></sl-icon> Generate missing</sl-button>` : ''}
            <sl-dropdown hoist>
              <sl-button size="small" slot="trigger" caret>More</sl-button>
              <sl-menu id="cs-codes-menu">
                <sl-menu-item value="print"><sl-icon slot="prefix" name="printer"></sl-icon> Print code slips</sl-menu-item>
                <sl-menu-item value="csv"><sl-icon slot="prefix" name="filetype-csv"></sl-icon> Export CSV</sl-menu-item>
                <sl-divider></sl-divider>
                <sl-menu-item value="regen-all"><sl-icon slot="prefix" name="arrow-repeat"></sl-icon> Regenerate all codes…</sl-menu-item>
              </sl-menu>
            </sl-dropdown>
          </div>
        </div>
        <div class="rounded-xl border border-slate-200 overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-xs text-slate-500">
              <tr><th class="text-left font-semibold px-4 py-2">Student</th><th class="text-left font-semibold px-4 py-2">Access code</th><th class="px-4 py-2"><span class="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              ${students.map((s, i) => `
                <tr class="border-t border-slate-100">
                  <td class="px-4 py-2">
                    <div class="font-medium text-slate-800">${esc(s.full_name)}</div>
                    <div class="text-[11px] text-slate-400 tabular-nums">${esc(s.student_id)}</div>
                  </td>
                  <td class="px-4 py-2 font-mono tracking-wider text-slate-800">
                    ${s.access_code ? (revealCodes ? esc(s.access_code) : '••••-••••') : '<span class="font-sans text-xs text-amber-700">Not set</span>'}
                  </td>
                  <td class="px-2 py-1 text-right whitespace-nowrap">
                    ${s.previous_access_codes?.length ? `<button type="button" class="kb-icon-btn cs-code-history text-amber-600 hover:text-amber-800" data-i="${i}" aria-label="Past access codes for ${esc(s.full_name)}" title="Code history (${s.previous_access_codes.length} past codes)"><sl-icon name="clock-history"></sl-icon></button>` : ''}
                    ${s.access_code ? `<button type="button" class="kb-icon-btn cs-code-copy" data-i="${i}" aria-label="Copy code for ${esc(s.full_name)}" title="Copy"><sl-icon name="clipboard"></sl-icon></button>` : ''}
                    <button type="button" class="kb-icon-btn cs-code-set" data-i="${i}" aria-label="Set a custom code for ${esc(s.full_name)}" title="Set custom code"><sl-icon name="pencil"></sl-icon></button>
                    <button type="button" class="kb-icon-btn cs-code-regen" data-i="${i}" aria-label="Generate a new code for ${esc(s.full_name)}" title="New random code"><sl-icon name="arrow-repeat"></sl-icon></button>
                  </td>
                </tr>`).join('') || '<tr><td colspan="3" class="px-4 py-6 text-center text-slate-500 text-sm">No students in this class yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;
  };

  const TABS = [
    { key: 'general', label: 'General', icon: 'sliders', panel: generalPanel },
    { key: 'categories', label: 'Categories & policies', icon: 'collection', panel: categoriesPanel },
    { key: 'scale', label: 'Grading scale', icon: 'bar-chart-steps', panel: scalePanel },
    { key: 'standards', label: 'Standards', icon: 'bullseye', panel: standardsPanel },
    { key: 'access', label: 'Student access', icon: 'key', panel: accessPanel }
  ];

  const render = () => {
    const scrollTop = dialog.querySelector('.cs-panel')?.scrollTop || 0;
    dialog.innerHTML = `
      <div class="flex flex-col md:flex-row gap-5 -mt-2">
        <nav class="flex md:flex-col gap-1 overflow-x-auto md:w-48 flex-shrink-0" aria-label="Settings sections">
          ${TABS.map(t => `
            <button type="button" class="cs-tab flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap text-left transition-colors ${activeTab === t.key ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-600 hover:bg-slate-100'}" data-tab="${t.key}" ${activeTab === t.key ? 'aria-current="page"' : ''}>
              <sl-icon name="${t.icon}"></sl-icon> ${t.label}
            </button>`).join('')}
        </nav>
        <div class="cs-panel flex-1 min-w-0 h-[64vh] overflow-y-auto pr-1">
          ${TABS.find(t => t.key === activeTab).panel()}
        </div>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="cs-cancel">Cancel</sl-button>
        <sl-button variant="primary" id="cs-save">Save settings</sl-button>
      </div>`;
    const panel = dialog.querySelector('.cs-panel');
    if (panel) panel.scrollTop = scrollTop;
    bind();
  };

  const setActiveTab = async (key) => {
    activeTab = key;
    if (key === 'access') await loadStudents();
    render();
  };

  const loadStudents = async () => {
    students = await storage.table('gradebook_students').where('course_id').equals(draft.id).toArray();
    students.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  };

  const ensureZeroLevel = (include) => {
    const has = draft.sbg.levels.some(l => Number(l.value) === 0);
    if (include && !has) draft.sbg.levels.push({ value: 0, label: 'No evidence', description: 'Not enough evidence yet to assess.', color: '#64748b' });
    if (!include && has) draft.sbg.levels = draft.sbg.levels.filter(l => Number(l.value) !== 0);
  };

  const importStandards = (list, sourceName) => {
    const existingCodes = new Set(draft.standards.map(s => s.code.toUpperCase()));
    let added = 0;
    for (const s of list) {
      if (existingCodes.has(s.code.toUpperCase())) continue;
      draft.standards.push({ id: generateUUID(), code: s.code, description: s.description, source: sourceName || 'custom' });
      existingCodes.add(s.code.toUpperCase());
      added++;
    }
    toast.success(added ? `Added ${added} standard${added === 1 ? '' : 's'}.` : 'Those standards are already in this class.');
    render();
  };

  const openPasteDialog = () => {
    const d = document.createElement('sl-dialog');
    d.label = 'Paste standards';
    d.innerHTML = `
      <div class="space-y-3">
        <p class="text-xs text-slate-500">One standard per line. Use a comma, tab, colon or dash between the code and the description, e.g. <code>HS-PS1-1, Use the periodic table…</code></p>
        <sl-textarea id="paste-std" rows="10" placeholder="CODE, description"></sl-textarea>
        <div class="flex items-center justify-between text-xs text-slate-500">
          <p id="paste-std-count">0 standards detected</p>
          <sl-button size="small" variant="default" id="paste-template">
            <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Download CSV Template
          </sl-button>
        </div>
      </div>
      <div slot="footer" class="flex justify-end gap-2"><sl-button id="paste-cancel">Cancel</sl-button><sl-button variant="primary" id="paste-ok">Import</sl-button></div>`;
    document.body.appendChild(d);
    d.show();
    const ta = d.querySelector('#paste-std');
    ta.addEventListener('sl-input', () => {
      d.querySelector('#paste-std-count').textContent = `${parseStandardsText(ta.value).length} standards detected`;
    });
    d.querySelector('#paste-template')?.addEventListener('click', () => {
      downloadCSVTemplate('standards_template.csv', STANDARDS_CSV_TEMPLATE);
      toast.success('Downloaded standards CSV template');
    });
    d.querySelector('#paste-cancel').addEventListener('click', () => d.hide());
    d.querySelector('#paste-ok').addEventListener('click', () => {
      const list = parseStandardsText(ta.value);
      if (!list.length) { toast.warning('No standards detected. Use "CODE, description" on each line.'); return; }
      d.hide();
      importStandards(list, 'pasted');
    });
    d.addEventListener('sl-after-hide', (e) => { if (e.target === d) d.remove(); });
  };

  const printCodeSlips = () => {
    AccessCodes.printSlips(students, draft);
  };

  // ---------------------------------------------------------------------------
  // Bindings
  // ---------------------------------------------------------------------------
  function bind() {
    dialog.querySelectorAll('.cs-tab').forEach(b => b.addEventListener('click', () => setActiveTab(b.dataset.tab)));
    dialog.querySelector('#cs-cancel')?.addEventListener('click', () => dialog.hide());
    dialog.querySelector('#cs-save')?.addEventListener('click', () => {
      if (!String(draft.name || '').trim()) {
        toast.warning('Class name cannot be empty.');
        activeTab = 'general';
        render();
        return;
      }
      draft.letter_scale.bands = draft.letter_scale.bands.filter(b => String(b.label).trim() !== '');
      draft.updated_at = new Date().toISOString();
      savedSettings = true;
      dialog.hide();
      onSave(draft);
    });

    // General
    dialog.querySelector('#cs-name')?.addEventListener('sl-input', e => { draft.name = e.target.value; });
    dialog.querySelector('#cs-section')?.addEventListener('sl-input', e => { draft.section = e.target.value; });
    dialog.querySelector('#cs-year')?.addEventListener('sl-input', e => { draft.academic_year = e.target.value; });
    dialog.querySelector('#cs-mode')?.addEventListener('sl-change', e => { draft.grading_scale = e.target.value; });
    dialog.querySelectorAll('.cs-term-name').forEach(inp => inp.addEventListener('sl-input', () => { draft.terms[Number(inp.dataset.i)].name = inp.value; }));
    dialog.querySelectorAll('.cs-del-term').forEach(b => b.addEventListener('click', () => { draft.terms.splice(Number(b.dataset.i), 1); render(); }));
    dialog.querySelector('#cs-add-term')?.addEventListener('click', () => { draft.terms.push({ id: generateUUID(), name: `Term ${draft.terms.length + 1}` }); render(); });

    // Categories & policies
    dialog.querySelectorAll('.cs-cat').forEach(inp => inp.addEventListener('sl-input', () => {
      const c = draft.categories[Number(inp.dataset.i)];
      c[inp.dataset.f] = inp.dataset.f === 'name' ? inp.value : (Number(inp.value) || 0);
    }));
    dialog.querySelectorAll('.cs-cat[data-f="weight_pct"]').forEach(inp => inp.addEventListener('sl-change', () => render()));
    dialog.querySelectorAll('.cs-pol').forEach(inp => {
      const handler = () => {
        const c = draft.categories[Number(inp.dataset.i)];
        c.policy = c.policy || {};
        c.policy[inp.dataset.f] = inp.dataset.f === 'late_mode' ? inp.value : (Number(inp.value) || 0);
        if (inp.dataset.f === 'late_mode') render();
      };
      inp.addEventListener(inp.tagName === 'SL-SELECT' ? 'sl-change' : 'sl-input', handler);
    });
    dialog.querySelectorAll('.cs-del-cat').forEach(b => b.addEventListener('click', () => { draft.categories.splice(Number(b.dataset.i), 1); render(); }));
    dialog.querySelector('#cs-add-cat')?.addEventListener('click', () => {
      draft.categories.push({ id: generateUUID(), name: `Category ${draft.categories.length + 1}`, weight_pct: 0, drop_lowest: 0, policy: { late_mode: 'none', missing_floor_pct: 0 } });
      render();
    });

    // Grading scale
    dialog.querySelector('#cs-scale-preset')?.addEventListener('sl-change', e => {
      const preset = LETTER_SCALE_PRESETS[e.target.value];
      if (preset) draft.letter_scale = { preset: e.target.value, bands: clone(preset.bands) };
      else draft.letter_scale.preset = 'custom';
      render();
    });
    dialog.querySelector('#cs-scale-copy')?.addEventListener('sl-change', e => {
      const src = otherCourses.find(c => c.id === e.target.value);
      if (!src) return;
      draft.letter_scale = clone(getLetterScale(src));
      toast.success(`Copied grading scale from ${src.name}.`);
      render();
    });
    dialog.querySelectorAll('.cs-band').forEach(inp => {
      inp.addEventListener('sl-input', () => {
        const b = draft.letter_scale.bands[Number(inp.dataset.i)];
        b[inp.dataset.f] = inp.dataset.f === 'min' ? (Number(inp.value) || 0) : inp.value;
        draft.letter_scale.preset = 'custom';
      });
      inp.addEventListener('sl-change', () => render());
    });
    dialog.querySelectorAll('.cs-del-band').forEach(b => b.addEventListener('click', () => {
      draft.letter_scale.bands.splice(Number(b.dataset.i), 1);
      draft.letter_scale.preset = 'custom';
      render();
    }));
    dialog.querySelector('#cs-add-band')?.addEventListener('click', () => {
      draft.letter_scale.bands.push({ label: '', min: 0 });
      draft.letter_scale.preset = 'custom';
      render();
    });

    // Standards & SBG
    dialog.querySelectorAll('.cs-std').forEach(inp => inp.addEventListener('sl-input', () => {
      draft.standards[Number(inp.dataset.i)][inp.dataset.f] = inp.value;
    }));
    dialog.querySelectorAll('.cs-del-std').forEach(b => b.addEventListener('click', () => { draft.standards.splice(Number(b.dataset.i), 1); render(); }));
    dialog.querySelector('#cs-add-std')?.addEventListener('click', () => {
      draft.standards.push({ id: generateUUID(), code: `STD-${draft.standards.length + 1}`, description: '', source: 'custom' });
      render();
    });
    const csvInput = dialog.querySelector('#cs-std-csv');
    dialog.querySelector('#cs-std-presets')?.addEventListener('sl-select', e => {
      const v = e.detail.item.value;
      if (v === '__paste') return openPasteDialog();
      if (v === '__csv') return csvInput?.click();
      if (v === '__template') {
        downloadCSVTemplate('standards_template.csv', STANDARDS_CSV_TEMPLATE);
        toast.success('Downloaded standards CSV template');
        return;
      }
      const preset = STANDARD_SET_PRESETS.find(p => p.key === v);
      if (preset) importStandards(preset.standards, preset.key);
    });
    csvInput?.addEventListener('change', async () => {
      const file = csvInput.files?.[0];
      if (!file) return;
      const list = parseStandardsText(await file.text());
      csvInput.value = '';
      if (!list.length) { toast.warning('No standards found. The CSV needs a code column followed by a description column.'); return; }
      importStandards(list, file.name);
    });
    dialog.querySelectorAll('.cs-lvl').forEach(inp => {
      const evt = inp.tagName === 'INPUT' ? 'input' : 'sl-input';
      inp.addEventListener(evt, () => { draft.sbg.levels[Number(inp.dataset.i)][inp.dataset.f] = inp.value; });
    });
    dialog.querySelector('#cs-include-zero')?.addEventListener('sl-change', e => { ensureZeroLevel(e.target.checked); render(); });
    dialog.querySelector('#cs-calc')?.addEventListener('sl-change', e => { draft.sbg.calculation = e.target.value; render(); });
    dialog.querySelector('#cs-decay')?.addEventListener('sl-input', e => {
      draft.sbg.decay_weight = Math.min(0.95, Math.max(0.05, Number(e.target.value) || 0.65));
    });
    dialog.querySelectorAll('.cs-mband').forEach(inp => inp.addEventListener('sl-input', () => {
      const b = draft.sbg.mastery_bands[Number(inp.dataset.i)];
      b[inp.dataset.f] = inp.dataset.f === 'letter' ? inp.value : (Number(inp.value) || 0);
    }));
    dialog.querySelectorAll('.cs-del-mband').forEach(b => b.addEventListener('click', () => { draft.sbg.mastery_bands.splice(Number(b.dataset.i), 1); render(); }));
    dialog.querySelector('#cs-add-mband')?.addEventListener('click', () => { draft.sbg.mastery_bands.push({ min: 0, letter: '', percent: 0 }); render(); });

    // Student access codes (saved immediately)
    dialog.querySelector('#cs-codes-reveal')?.addEventListener('click', () => { revealCodes = !revealCodes; render(); });
    dialog.querySelector('#cs-codes-generate')?.addEventListener('click', async () => {
      await AccessCodes.ensureForCourse(draft.id);
      accessChanged = true;
      await loadStudents();
      revealCodes = true;
      toast.success('Access codes generated.');
      render();
    });
    dialog.querySelectorAll('.cs-code-copy').forEach(b => b.addEventListener('click', async () => {
      const s = students[Number(b.dataset.i)];
      try { await navigator.clipboard.writeText(s.access_code); toast.success(`Copied ${s.full_name}'s code.`); } catch (_) { toast.warning('Copy failed — reveal the code and copy it manually.'); }
    }));
    dialog.querySelectorAll('.cs-code-history').forEach(b => b.addEventListener('click', async () => {
      const s = students[Number(b.dataset.i)];
      const { openAccessCodeHistoryDialog } = await import('./access-code-history-dialog.js');
      openAccessCodeHistoryDialog(s, draft, {
        onUpdated: () => {
          accessChanged = true;
          render();
        }
      });
    }));
    dialog.querySelectorAll('.cs-code-regen').forEach(b => b.addEventListener('click', async () => {
      const s = students[Number(b.dataset.i)];
      if (s.access_code) {
        const ok = await ConfirmDialog.show({
          title: 'Replace access code?',
          message: `${Sanitizer.escapeHTML(s.full_name)}'s current code stops working for new grade links and assignment submissions.`,
          confirmText: 'Generate new code'
        });
        if (!ok) return;
      }
      await AccessCodes.regenerate(s);
      revealCodes = true;
      accessChanged = true;
      render();

    }));
    dialog.querySelectorAll('.cs-code-set').forEach(b => b.addEventListener('click', () => {
      const s = students[Number(b.dataset.i)];
      const d = document.createElement('sl-dialog');
      d.label = `Access code for ${s.full_name}`;
      d.innerHTML = `
        <div class="space-y-3">
          <sl-input id="custom-code" label="New access code" value="${esc(s.access_code || generateAccessCode())}" help-text="At least ${MIN_ACCESS_CODE_LENGTH} letters or digits. Avoid names, birthdays or student IDs." autofocus></sl-input>
        </div>
        <div slot="footer" class="flex justify-end gap-2"><sl-button id="cc-cancel">Cancel</sl-button><sl-button variant="primary" id="cc-save">Save code</sl-button></div>`;
      document.body.appendChild(d);
      d.show();
      d.querySelector('#cc-cancel').addEventListener('click', () => d.hide());
      d.querySelector('#cc-save').addEventListener('click', async () => {
        try {
          await AccessCodes.setCustom(s, d.querySelector('#custom-code').value);
      accessChanged = true;
          d.hide();
          revealCodes = true;
          toast.success('Access code updated.');
          render();
        } catch (err) {
          toast.warning(err.message);
        }
      });
      d.addEventListener('sl-after-hide', (e) => { if (e.target === d) d.remove(); });
    }));
    dialog.querySelector('#cs-codes-menu')?.addEventListener('sl-select', async e => {
      const v = e.detail.item.value;
      if (v === 'print') return printCodeSlips();
      if (v === 'csv') {
        const filename = `${(draft.name || 'class').replace(/[^a-z0-9]+/gi, '_')}_access_codes.csv`;
        downloadCSV(filename, AccessCodes.toCSV(students, draft));
        toast.success(`Exported access codes to ${filename}`);
        return;
      }
      if (v === 'regen-all') {
        const ok = await ConfirmDialog.show({
          title: 'Regenerate every code?',
          message: 'All current codes stop working for new grade links and submissions. Students will need their new codes.',
          confirmText: 'Regenerate all',
          variant: 'danger'
        });
        if (!ok) return;
        for (const s of students) await AccessCodes.regenerate(s);
      accessChanged = true;
        revealCodes = true;
        toast.success('All access codes regenerated.');
        render();
      }
    });
  }

  dialog.addEventListener('sl-request-close', (e) => {
    // Keep the dialog open when nested dialogs/menus close
    if (e.target !== dialog) e.preventDefault?.();
  });
  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target !== dialog) return;
    dialog.remove();
    // Access codes save immediately, so refresh the roster even when settings were cancelled
    if (accessChanged && !savedSettings) onAccessChanged?.();
  });

  document.body.appendChild(dialog);
  setActiveTab(activeTab).then(() => dialog.show());
  return dialog;
}

export default openCourseSettingsDialog;
