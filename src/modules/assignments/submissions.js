import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { toast } from '../../utils/toast.js';
import { GradebookBridge } from '../gradebook/bridge.js';
import { evaluateSubmission, splitSubmissionText, IDENTITY_LABELS, DECRYPT_ERRORS } from './pipeline.js';
import { finalScore, totalPoints, describeCorrectAnswer, BLANK_TOKEN } from './grading.js';
import { QUESTION_TYPE_META } from './question-types.js';

/**
 * Submissions Inbox (KB-ASSIGN-006)
 * Import encrypted hand-ins, verify identity, review/override scores, and sync to the gradebook.
 */

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

const IDENTITY_CLASSES = {
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200'
};

export function identityChip(identity) {
  const info = IDENTITY_LABELS[identity] || IDENTITY_LABELS.no_code_on_file;
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${IDENTITY_CLASSES[info.tone]}" title="${esc(info.help)}"><sl-icon name="${info.icon}"></sl-icon>${info.label}</span>`;
}

function formatAnswer(q, v) {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '<span class="text-slate-400">No answer</span>';
  switch (q.type) {
    case 'single_choice': return esc(q.options?.find(o => o.id === v)?.text ?? '(removed option)');
    case 'multi_choice': return esc((q.options || []).filter(o => v.includes(o.id)).map(o => o.text).join('; ') || '—');
    case 'true_false': return v === true || v === 'true' ? 'True' : 'False';
    case 'fill_blank': return esc(v.map((x, i) => `${i + 1}. ${x || '—'}`).join('   '));
    case 'ordering': return esc(v.map(id => q.items?.find(i => i.id === id)?.text || '?').join(' → '));
    case 'matching': return esc((q.pairs || []).map(p => `${p.left} → ${v[p.id] || '—'}`).join('; '));
    case 'long_text': return `<div class="whitespace-pre-wrap">${esc(v)}</div>`;
    default: return esc(v);
  }
}

export async function renderSubmissions(assignment, router, container) {
  const a = assignment;
  const courseId = a.gradebook?.course_id || a.class_id || null;

  let course = null;
  let roster = [];
  let submissions = [];

  const load = async () => {
    [course, roster, submissions] = await Promise.all([
      courseId ? storage.table('gradebook_courses').get(courseId) : null,
      courseId ? storage.table('gradebook_students').where('course_id').equals(courseId).toArray().catch(() => []) : [],
      storage.table('assignment_submissions').where('assignment_id').equals(a.id).toArray().catch(() => [])
    ]);
    roster.sort((x, y) => (x.full_name || '').localeCompare(y.full_name || ''));
  };

  const latestFor = (studentId) => submissions
    .filter(s => s.is_latest !== false && String(s.student_id).toUpperCase() === String(studentId).toUpperCase())
    .sort((x, y) => (y.submitted_at || '').localeCompare(x.submitted_at || ''))[0] || null;

  const render = () => {
    const latest = submissions.filter(s => s.is_latest !== false);
    const rosterIds = new Set(roster.map(s => String(s.student_id).toUpperCase()));
    const strangers = latest.filter(s => !rosterIds.has(String(s.student_id).toUpperCase()));
    const scores = latest.map(s => finalScore(a, s));
    const maxPts = totalPoints(a);
    const avg = scores.length ? Math.round((scores.reduce((t, s) => t + (s.possible ? s.earned / s.possible : 0), 0) / scores.length) * 100) : null;
    const pendingReview = scores.filter(s => s.pending > 0).length;
    const warnings = latest.filter(s => s.identity !== 'verified').length;
    const unsynced = latest.filter(s => !s.synced_at || (s.updated_at && s.updated_at > s.synced_at)).length;

    const row = (student, sub) => {
      const score = sub ? finalScore(a, sub) : null;
      const status = !sub
        ? '<span class="inline-flex items-center gap-1 text-xs text-slate-400"><sl-icon name="circle"></sl-icon>Not submitted</span>'
        : `<span class="inline-flex items-center gap-1 text-xs text-slate-700"><sl-icon name="check-circle-fill" class="text-emerald-600"></sl-icon>Submitted</span>${sub.days_late ? ` <span class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700">${sub.days_late}d LATE</span>` : ''}`;
      return `
        <tr class="border-t border-slate-200 ${sub ? 'hover:bg-slate-50 cursor-pointer' : ''}" ${sub ? `data-open="${esc(sub.id)}" tabindex="0"` : ''}>
          <td class="px-4 py-3">
            <div class="font-medium text-slate-900">${esc(student?.full_name || sub?.student_name || sub?.claimed_name)}</div>
            <div class="text-xs text-slate-400 tabular-nums">${esc(student?.student_id || sub?.student_id)}</div>
          </td>
          <td class="px-4 py-3">${status}</td>
          <td class="px-4 py-3 hidden md:table-cell">${sub ? identityChip(sub.identity) : ''}</td>
          <td class="px-4 py-3 text-right tabular-nums">
            ${score ? `<span class="font-semibold text-slate-900">${score.earned}</span><span class="text-slate-400"> / ${score.possible}</span>${score.pending ? `<div class="text-[11px] text-amber-700">${score.pending} to review</div>` : ''}` : '<span class="text-slate-300">—</span>'}
          </td>
          <td class="px-4 py-3 text-xs text-slate-500 hidden sm:table-cell">${sub ? esc(new Date(sub.submitted_at).toLocaleString()) : ''}</td>
          <td class="px-4 py-3 text-xs hidden lg:table-cell">${sub ? (sub.synced_at && !(sub.updated_at > sub.synced_at) ? '<span class="text-emerald-700 inline-flex items-center gap-1"><sl-icon name="journal-check"></sl-icon>Synced</span>' : '<span class="text-slate-400">Not synced</span>') : ''}</td>
        </tr>`;
    };

    container.innerHTML = `
      <div class="space-y-6 max-w-7xl mx-auto">
        <div class="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
          <div class="flex items-center gap-3 min-w-0">
            <sl-button size="small" id="sub-back"><sl-icon slot="prefix" name="arrow-left"></sl-icon> Editor</sl-button>
            <div class="min-w-0">
              <h1 class="font-bold text-slate-900 text-lg truncate">Submissions · ${esc(a.title)}</h1>
              <p class="text-xs text-slate-500">${course ? `${esc(course.name)} · ` : 'No class linked · '}${maxPts} pts${a.settings?.due_date ? ` · due ${esc(new Date(`${a.settings.due_date}T12:00:00`).toLocaleDateString())}` : ''}</p>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <sl-button size="small" id="sub-paste"><sl-icon slot="prefix" name="clipboard-plus"></sl-icon> Paste codes</sl-button>
            <sl-button size="small" id="sub-import"><sl-icon slot="prefix" name="upload"></sl-icon> Import .kbsub files</sl-button>
            <sl-button size="small" variant="primary" id="sub-sync" ${!course || !latest.length ? 'disabled' : ''}><sl-icon slot="prefix" name="journal-arrow-up"></sl-icon> Sync to gradebook${unsynced ? ` (${unsynced})` : ''}</sl-button>
            <input type="file" id="sub-file" accept=".kbsub,.txt,.json" multiple class="hidden" />
          </div>
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          ${[
            ['Submitted', `${latest.length}${roster.length ? ` / ${roster.length}` : ''}`, 'inbox', 'text-amber-600'],
            ['Average', avg === null ? '—' : `${avg}%`, 'bar-chart', 'text-blue-600'],
            ['Needs review', String(pendingReview), 'pencil-square', 'text-violet-600'],
            ['Identity warnings', String(warnings), 'shield-exclamation', warnings ? 'text-rose-600' : 'text-slate-400']
          ].map(([label, value, icon, color]) => `
            <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div class="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-500"><span>${label}</span><sl-icon name="${icon}" class="${color} text-base"></sl-icon></div>
              <div class="text-2xl font-bold text-slate-900 mt-2 tabular-nums">${value}</div>
            </div>`).join('')}
        </div>

        ${!course ? `
          <sl-alert variant="warning" open><sl-icon slot="icon" name="exclamation-triangle"></sl-icon>
            Link this assignment to a class in the editor to verify student identities and sync grades.</sl-alert>` : ''}

        <div class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          ${roster.length || latest.length ? `
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 text-left">
                  <tr>
                    <th class="px-4 py-3 font-semibold">Student</th>
                    <th class="px-4 py-3 font-semibold">Status</th>
                    <th class="px-4 py-3 font-semibold hidden md:table-cell">Identity</th>
                    <th class="px-4 py-3 font-semibold text-right">Score</th>
                    <th class="px-4 py-3 font-semibold hidden sm:table-cell">Submitted</th>
                    <th class="px-4 py-3 font-semibold hidden lg:table-cell">Gradebook</th>
                  </tr>
                </thead>
                <tbody>
                  ${roster.map(s => row(s, latestFor(s.student_id))).join('')}
                  ${strangers.map(sub => row(null, sub)).join('')}
                </tbody>
              </table>
            </div>` : `
            <div class="p-10 text-center space-y-3">
              <span class="w-12 h-12 mx-auto rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center text-2xl"><sl-icon name="inbox"></sl-icon></span>
              <h3 class="font-semibold text-slate-900">No submissions yet</h3>
              <p class="text-sm text-slate-500 max-w-md mx-auto">Students download a <code>.kbsub</code> file or copy a submission code when they finish. Import the files or paste the codes here.</p>
            </div>`}
        </div>
      </div>`;

    bind();
  };

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------
  async function importTexts(texts) {
    const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
    const errors = [];
    let added = 0;
    let duplicates = 0;
    for (const { text, source } of texts) {
      try {
        const sub = await evaluateSubmission({ text, teacherPrivateJwk: keys.privateJwk, assignment: a, roster });
        const dupe = submissions.find(s => s.student_id === sub.student_id && s.submitted_at === sub.submitted_at);
        if (dupe) { duplicates++; continue; }
        // Older submissions from the same student stay on file but stop counting
        for (const prev of submissions.filter(s => String(s.student_id).toUpperCase() === String(sub.student_id).toUpperCase() && s.is_latest !== false)) {
          if ((prev.submitted_at || '') < (sub.submitted_at || '')) {
            prev.is_latest = false;
            await storage.table('assignment_submissions').put(prev);
          } else {
            sub.is_latest = false;
          }
        }
        await storage.table('assignment_submissions').put(sub);
        submissions.push(sub);
        added++;
      } catch (err) {
        errors.push({ source, message: DECRYPT_ERRORS[err.message] || err.message });
      }
    }
    await load();
    render();
    if (added) toast.success(`Imported ${added} submission${added === 1 ? '' : 's'}.`);
    if (duplicates) toast.info(`${duplicates} already imported.`);
    if (errors.length) showImportErrors(errors);
  }

  function showImportErrors(errors) {
    const dialog = document.createElement('sl-dialog');
    dialog.label = `${errors.length} submission${errors.length === 1 ? '' : 's'} could not be imported`;
    dialog.innerHTML = `
      <ul class="space-y-2 text-sm">
        ${errors.map(e => `<li class="p-3 rounded-lg bg-rose-50 border border-rose-200"><div class="font-medium text-rose-800">${esc(e.source)}</div><div class="text-rose-700">${esc(e.message)}</div></li>`).join('')}
      </ul>
      <sl-button slot="footer" variant="primary">Close</sl-button>`;
    document.body.appendChild(dialog);
    dialog.querySelector('sl-button[slot="footer"]').addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
    dialog.show();
  }

  function openPasteDialog() {
    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Paste submission codes';
    dialog.style.setProperty('--width', '600px');
    dialog.innerHTML = `
      <div class="space-y-3">
        <p class="text-sm text-slate-500">Paste one or more codes starting with <code>KBSUB1.</code> — for example, copied from LMS comments. Extra text around them is ignored.</p>
        <sl-textarea id="sub-paste-text" rows="8" resize="auto" placeholder="KBSUB1.eyJrYnN1YiI6MS…"></sl-textarea>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="sub-paste-cancel">Cancel</sl-button>
        <sl-button variant="primary" id="sub-paste-go"><sl-icon slot="prefix" name="upload"></sl-icon> Import</sl-button>
      </div>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
    dialog.show();
    dialog.querySelector('#sub-paste-cancel').addEventListener('click', () => dialog.hide());
    dialog.querySelector('#sub-paste-go').addEventListener('click', async () => {
      const parts = splitSubmissionText(dialog.querySelector('#sub-paste-text').value);
      if (!parts.length) { toast.warning('Nothing to import.'); return; }
      dialog.hide();
      await importTexts(parts.map((text, i) => ({ text, source: `Pasted code ${i + 1}` })));
    });
  }

  // ---------------------------------------------------------------------------
  // Review drawer
  // ---------------------------------------------------------------------------
  function openReview(sub) {
    const existing = document.getElementById('kb-submission-review');
    if (existing) existing.remove();
    const draft = { manual: JSON.parse(JSON.stringify(sub.manual || {})), feedback: sub.feedback || '' };
    const drawer = document.createElement('sl-drawer');
    drawer.id = 'kb-submission-review';
    drawer.label = sub.student_name || sub.student_id;
    drawer.style.setProperty('--size', 'min(760px, 100vw)');

    const scoreLine = () => {
      const s = finalScore(a, { ...sub, manual: draft.manual });
      return `<span class="text-2xl font-bold text-slate-900 tabular-nums">${s.earned}</span><span class="text-slate-400"> / ${s.possible} pts</span>${s.pending ? `<span class="ml-2 text-xs text-amber-700">${s.pending} still to grade</span>` : ''}`;
    };

    drawer.innerHTML = `
      <div class="space-y-5">
        <div class="flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl bg-slate-50 border border-slate-200">
          <div class="space-y-1">
            <div class="flex items-center gap-2 flex-wrap">${identityChip(sub.identity)}
              ${sub.days_late ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700">${sub.days_late}d LATE</span>` : ''}
              ${sub.stale_version ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-700" title="Submitted against an earlier published version; re-graded with the current key.">OLDER VERSION</span>' : ''}
            </div>
            <div class="text-xs text-slate-500">${esc(sub.student_id)} · submitted ${esc(new Date(sub.submitted_at).toLocaleString())}${sub.claimed_name && sub.claimed_name !== sub.student_name ? ` · typed name “${esc(sub.claimed_name)}”` : ''}</div>
            ${sub.identity !== 'verified' ? `<div class="text-xs text-rose-700">${esc(IDENTITY_LABELS[sub.identity]?.help || '')}</div>` : ''}
          </div>
          <div id="review-score">${scoreLine()}</div>
        </div>

        <ol class="space-y-4">
          ${(a.questions || []).map((q, i) => {
            const auto = sub.auto?.per_question?.[q.id] || { earned: 0, possible: q.points || 0, needs_manual: q.type === 'long_text' };
            const m = draft.manual[q.id] || {};
            const meta = QUESTION_TYPE_META[q.type] || {};
            const tone = auto.needs_manual ? 'border-amber-300' : auto.correct ? 'border-emerald-200' : auto.earned > 0 ? 'border-blue-200' : 'border-rose-200';
            return `
              <li class="rounded-xl border ${tone} p-4 space-y-3" data-review-q="${esc(q.id)}">
                <div class="flex items-start justify-between gap-3">
                  <div class="text-sm min-w-0">
                    <div class="text-xs text-slate-400 flex items-center gap-1.5 mb-1"><sl-icon name="${meta.icon || 'question'}"></sl-icon>${i + 1}. ${esc(meta.label || q.type)}</div>
                    <div class="kb-prose text-slate-900 [&_p]:m-0">${Sanitizer.renderSTEMMarkdown(String(q.prompt || '').replace(BLANK_TOKEN, '____'))}</div>
                  </div>
                  <span class="text-xs font-semibold tabular-nums whitespace-nowrap ${auto.needs_manual ? 'text-amber-700' : 'text-slate-500'}">${auto.needs_manual ? 'Manual' : `Auto ${auto.earned} / ${auto.possible}`}</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div class="p-3 rounded-lg bg-slate-50 border border-slate-200"><div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Student answer</div><div class="text-slate-800">${formatAnswer(q, sub.answers?.[q.id])}</div></div>
                  <div class="p-3 rounded-lg bg-emerald-50 border border-emerald-200"><div class="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 mb-1">${q.type === 'long_text' ? 'Grading notes' : 'Answer key'}</div><div class="text-emerald-900">${esc(q.type === 'long_text' ? (q.rubric_hint || '—') : describeCorrectAnswer(q))}</div></div>
                </div>
                <div class="flex flex-col sm:flex-row gap-3">
                  <sl-input size="small" type="number" min="0" max="${auto.possible}" step="0.5" class="sm:w-36" data-manual-points label="Points" placeholder="${auto.needs_manual ? '' : `${auto.earned} (auto)`}" value="${m.points ?? ''}" help-text="${auto.needs_manual ? 'Required' : 'Leave empty to keep auto score'}">
                    <span slot="suffix" class="text-xs text-slate-400">/ ${auto.possible}</span>
                  </sl-input>
                  <sl-textarea size="small" rows="1" resize="auto" class="flex-1" data-manual-feedback label="Feedback on this answer" value="${esc(m.feedback || '')}"></sl-textarea>
                </div>
              </li>`;
          }).join('')}
        </ol>

        <sl-textarea id="review-feedback" label="Overall feedback" rows="3" resize="auto" value="${esc(draft.feedback)}" placeholder="Shown to the student with their grade"></sl-textarea>
      </div>
      <div slot="footer" class="flex flex-wrap justify-end gap-2">
        <sl-button id="review-cancel">Cancel</sl-button>
        <sl-button id="review-save">Save</sl-button>
        <sl-button variant="primary" id="review-save-sync" ${course && roster.some(r => String(r.student_id).toUpperCase() === String(sub.student_id).toUpperCase()) ? '' : 'disabled'}><sl-icon slot="prefix" name="journal-arrow-up"></sl-icon> Save &amp; sync</sl-button>
      </div>`;

    document.body.appendChild(drawer);
    drawer.addEventListener('sl-after-hide', (e) => { if (e.target === drawer) drawer.remove(); });
    drawer.show();

    drawer.querySelectorAll('[data-review-q]').forEach(li => {
      const qid = li.dataset.reviewQ;
      li.querySelector('[data-manual-points]').addEventListener('sl-input', (e) => {
        draft.manual[qid] = { ...(draft.manual[qid] || {}), points: e.target.value === '' ? null : Number(e.target.value) };
        drawer.querySelector('#review-score').innerHTML = scoreLine();
      });
      li.querySelector('[data-manual-feedback]').addEventListener('sl-input', (e) => {
        draft.manual[qid] = { ...(draft.manual[qid] || {}), feedback: e.target.value };
      });
    });
    drawer.querySelector('#review-feedback').addEventListener('sl-input', (e) => { draft.feedback = e.target.value; });

    const persist = async () => {
      sub.manual = draft.manual;
      sub.feedback = draft.feedback;
      sub.updated_at = new Date().toISOString();
      await storage.table('assignment_submissions').put(sub);
    };
    drawer.querySelector('#review-cancel').addEventListener('click', () => drawer.hide());
    drawer.querySelector('#review-save').addEventListener('click', async () => {
      await persist();
      drawer.hide();
      toast.success('Review saved.');
      await load();
      render();
    });
    drawer.querySelector('#review-save-sync').addEventListener('click', async () => {
      await persist();
      drawer.hide();
      await syncToGradebook([sub]);
    });
  }

  // ---------------------------------------------------------------------------
  // Gradebook sync
  // ---------------------------------------------------------------------------
  function feedbackSummary(sub) {
    const s = finalScore(a, sub);
    const lines = [];
    if (sub.feedback) lines.push(sub.feedback.trim());
    (a.questions || []).forEach((q, i) => {
      const fb = sub.manual?.[q.id]?.feedback;
      if (fb && fb.trim()) lines.push(`Q${i + 1}: ${fb.trim()}`);
    });
    lines.push(`Assignment: ${s.earned}/${s.possible} pts${s.pending ? ` (${s.pending} awaiting review)` : ''}.`);
    return lines.join('\n');
  }

  async function syncToGradebook(list) {
    if (!course) { toast.warning('Link a class first.'); return; }
    const rosterById = new Map(roster.map(s => [String(s.student_id).toUpperCase(), s]));
    const eligible = list.filter(s => s.is_latest !== false && rosterById.has(String(s.student_id).toUpperCase()));
    if (!eligible.length) { toast.info('Nothing to sync.'); return; }
    try {
      const column = await GradebookBridge.upsertLinkedColumn({
        courseId: course.id,
        source: { type: 'assignment', id: a.id },
        title: a.title,
        maxScore: totalPoints(a),
        categoryId: a.gradebook?.category_id || undefined,
        dueDate: a.settings?.due_date || undefined
      });
      if (a.gradebook?.column_id !== column.id) {
        a.gradebook = { ...(a.gradebook || {}), course_id: course.id, column_id: column.id };
        await storage.table('assignments').put(a);
      }
      const now = new Date().toISOString();
      let pending = 0;
      for (const sub of eligible) {
        const student = rosterById.get(String(sub.student_id).toUpperCase());
        const s = finalScore(a, sub);
        if (s.pending) pending++;
        await GradebookBridge.writeGrade({
          courseId: course.id,
          assignmentId: column.id,
          studentId: student.student_id,
          rawScore: s.earned,
          status: sub.days_late > 0 ? 'late' : 'submitted',
          feedback: feedbackSummary(sub),
          extra: { days_late: sub.days_late || undefined, source_submission_id: sub.id }
        });
        sub.synced_at = now;
        sub.updated_at = sub.updated_at && sub.updated_at > now ? sub.updated_at : now;
        await storage.table('assignment_submissions').put(sub);
      }
      toast.success(`Synced ${eligible.length} grade${eligible.length === 1 ? '' : 's'} to “${course.name}”.`);
      if (pending) toast.warning(`${pending} submission${pending === 1 ? ' has' : 's have'} answers still to grade; synced the current score.`);
    } catch (err) {
      console.error('Gradebook sync failed:', err);
      toast.danger(`Sync failed: ${err.message}`);
    }
    await load();
    render();
  }

  // ---------------------------------------------------------------------------
  // Bindings
  // ---------------------------------------------------------------------------
  function bind() {
    container.querySelector('#sub-back')?.addEventListener('click', () => router.navigate(`#/assignments/edit?id=${a.id}`));
    container.querySelector('#sub-paste')?.addEventListener('click', openPasteDialog);
    const fileInput = container.querySelector('#sub-file');
    container.querySelector('#sub-import')?.addEventListener('click', () => fileInput.click());
    fileInput?.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      const texts = [];
      for (const f of files) {
        const content = await f.text();
        const parts = splitSubmissionText(content);
        parts.forEach((text, i) => texts.push({ text, source: parts.length > 1 ? `${f.name} (#${i + 1})` : f.name }));
      }
      fileInput.value = '';
      if (texts.length) await importTexts(texts);
    });
    container.querySelector('#sub-sync')?.addEventListener('click', () => syncToGradebook(submissions.filter(s => s.is_latest !== false)));
    container.querySelectorAll('[data-open]').forEach(tr => {
      const open = () => {
        const sub = submissions.find(s => s.id === tr.dataset.open);
        if (sub) openReview(sub);
      };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  await load();
  render();
}
