import { Sanitizer } from '../../core/sanitizer.js';
import { getStandards, levelInfo, getSbgConfig, SBG_CALCULATION_METHODS } from './grading-scales.js';

/**
 * Standards Mastery View (KB-GRAD-010)
 * Students × standards table of current mastery, with an evidence popover per cell.
 */

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

function chip(course, value) {
  if (value === null || value === undefined) return '<span class="text-slate-300">—</span>';
  const lvl = levelInfo(course, value);
  return `<span class="inline-flex items-center justify-center min-w-[40px] px-2 py-1 rounded-lg text-xs font-bold text-white tabular-nums" style="background-color:${Sanitizer.safeColor(lvl?.color)}" title="${esc(lvl?.label || '')}">${Sanitizer.safeNumber(value).toFixed(1)}</span>`;
}

export function renderStandardsView(mount, { course, students, aggregates, onOpenSettings }) {
  const standards = getStandards(course);
  const cfg = getSbgConfig(course);

  if (standards.length === 0) {
    mount.innerHTML = `
      <div class="flex flex-col items-center justify-center text-center gap-3 p-10 bg-white rounded-xl border border-dashed border-slate-300">
        <span class="w-11 h-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-xl"><sl-icon name="bullseye"></sl-icon></span>
        <div class="space-y-1">
          <h3 class="font-semibold text-slate-900">No standards in this class yet</h3>
          <p class="text-sm text-slate-500 max-w-md">Import an official set (NGSS, Common Core) or paste your own list, then align assignments to them. Mastery per standard appears here.</p>
        </div>
        <sl-button variant="primary" size="small" id="btn-sv-settings"><sl-icon slot="prefix" name="journal-arrow-down"></sl-icon> Add standards</sl-button>
      </div>`;
    mount.querySelector('#btn-sv-settings')?.addEventListener('click', () => onOpenSettings?.('standards'));
    return;
  }

  const levels = [...cfg.levels].sort((a, b) => b.value - a.value);

  mount.innerHTML = `
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
        <span class="font-medium text-slate-700">${esc(SBG_CALCULATION_METHODS[cfg.calculation]?.name || '')}</span>
        ${levels.map(l => `<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:${Sanitizer.safeColor(l.color)}"></span>${esc(l.value)} ${esc(l.label)}</span>`).join('')}
      </div>
      <div class="overflow-auto rounded-xl border border-slate-200 bg-white shadow-xs" style="max-height: min(640px, calc(100vh - 260px));">
        <table class="text-sm border-separate border-spacing-0">
          <thead>
            <tr>
              <th class="sticky top-0 left-0 z-30 bg-slate-100 border-b border-r border-slate-200 text-left px-4 py-3 text-xs font-semibold text-slate-700 min-w-[220px]">Student</th>
              <th class="sticky top-0 z-20 bg-slate-100 border-b border-r border-slate-200 px-3 py-3 text-xs font-semibold text-slate-700 text-center">Overall</th>
              ${standards.map(s => `
                <th class="sticky top-0 z-20 bg-slate-100 border-b border-r border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 text-center min-w-[110px]" title="${esc(s.description)}">
                  <span class="block tabular-nums">${esc(s.code)}</span>
                  <span class="block text-[10px] font-normal text-slate-400 max-w-[140px] mx-auto truncate">${esc(s.description)}</span>
                </th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${students.map((st, r) => {
              const agg = aggregates.get(st.student_id) || {};
              const zebra = r % 2 ? 'bg-slate-50' : 'bg-white';
              return `
                <tr>
                  <td class="sticky left-0 z-10 ${zebra} border-b border-r border-slate-200 px-4 py-2">
                    <div class="font-medium text-slate-800">${esc(st.full_name)}</div>
                    <div class="text-[10px] text-slate-400 tabular-nums">${esc(st.student_id)}</div>
                  </td>
                  <td class="${zebra} border-b border-r border-slate-200 px-3 py-2 text-center whitespace-nowrap">
                    ${agg.mastery != null ? `${chip(course, agg.mastery)} <span class="ml-1 text-xs font-semibold text-slate-700">${esc(agg.letter)}</span>` : '<span class="text-slate-300">—</span>'}
                  </td>
                  ${standards.map(s => {
                    const b = agg.standards?.get(s.id);
                    return `<td class="${zebra} border-b border-r border-slate-200 px-3 py-2 text-center">
                      ${b && b.evidence.length ? `<button type="button" class="kb-sv-cell rounded-lg hover:ring-2 hover:ring-blue-200 focus-visible:ring-2" data-student="${esc(st.student_id)}" data-std="${esc(s.id)}" aria-label="${esc(st.full_name)}, ${esc(s.code)}: evidence">${chip(course, b.mastery)}</button>` : '<span class="text-slate-300">—</span>'}
                    </td>`;
                  }).join('')}
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <p class="text-xs text-slate-500">Select a cell to see the evidence behind it. Enter evidence from the Assignments view by scoring work aligned to standards.</p>
    </div>`;

  mount.querySelectorAll('.kb-sv-cell').forEach(btn => btn.addEventListener('click', () => {
    const st = students.find(s => s.student_id === btn.dataset.student);
    const std = standards.find(s => s.id === btn.dataset.std);
    const bucket = aggregates.get(btn.dataset.student)?.standards?.get(btn.dataset.std);
    if (!st || !std || !bucket) return;
    const d = document.createElement('sl-dialog');
    d.label = `${std.code} · ${st.full_name}`;
    d.innerHTML = `
      <div class="space-y-4">
        <p class="text-sm text-slate-600">${esc(std.description)}</p>
        <div class="flex items-center gap-3">${chip(course, bucket.mastery)}<span class="text-sm text-slate-600">current mastery from ${bucket.evidence.length} piece${bucket.evidence.length === 1 ? '' : 's'} of evidence</span></div>
        <ol class="space-y-2">
          ${bucket.evidence.map(ev => {
            const lvl = levelInfo(course, ev.level);
            return `<li class="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2">
              <div class="min-w-0"><div class="text-sm font-medium text-slate-800 truncate">${esc(ev.title)}</div><div class="text-[11px] text-slate-400">${esc(ev.date || '')}</div></div>
              <span class="text-xs font-semibold px-2 py-0.5 rounded-md text-white" style="background:${Sanitizer.safeColor(lvl?.color)}">${esc(ev.level)} ${esc(lvl?.label || '')}</span>
            </li>`;
          }).join('')}
        </ol>
      </div>
      <sl-button slot="footer" variant="primary" class="kb-sv-close">Close</sl-button>`;
    document.body.appendChild(d);
    d.show();
    d.querySelector('.kb-sv-close').addEventListener('click', () => d.hide());
    d.addEventListener('sl-after-hide', (e) => { if (e.target === d) d.remove(); });
  }));
}

export default renderStandardsView;
