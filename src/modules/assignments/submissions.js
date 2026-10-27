import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { toast } from '../../utils/toast.js';
import { GradebookBridge } from '../gradebook/bridge.js';
import { evaluateSubmission, splitSubmissionText, reconcileSubmissionWithAssignment, IDENTITY_LABELS, DECRYPT_ERRORS } from './pipeline.js';
import { finalScore, totalPoints, describeCorrectAnswer, BLANK_TOKEN } from './grading.js';
import { QUESTION_TYPE_META } from './question-types.js';
import { importSubmissionTexts } from './import.js';
import { LinkBuilder } from '../../core/links.js';
import { toCSV, downloadCSV, downloadBlob } from '../../core/csv.js';
import { splitName, joinName } from '../../core/names.js';
import { ExportDialog } from '../../components/export-dialog.js';
import { buildSubmissionsExportRows, buildMailMergeExportRows, buildNotSubmittedExportRows } from '../../core/export-presets.js';
import { createFeedbackLink } from './feedback-link.js';
import { generateFeedbackZip } from './feedback-pdf.js';
import { feedbackSummary, buildStudentPayload, answerToText } from './grading.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { replication } from '../../core/replication/manager.js';
import { StudentMatcher } from '../../core/student-matcher.js';

/**
 * Submissions Inbox (KB-ASSIGN-006)
 * Import encrypted hand-ins, verify identity, review/override scores, and sync to the gradebook.
 */

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

const IDENTITY_CLASSES = {
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200'
};

export function identityChip(identity) {
  const info = IDENTITY_LABELS[identity] || IDENTITY_LABELS.no_code_on_file;
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${IDENTITY_CLASSES[info.tone]}" title="${esc(info.help)}"><sl-icon name="${info.icon}"></sl-icon>${info.label}</span>`;
}

function formatAnswer(q, v) {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '<span class="text-slate-400">No answer</span>';
  if (q.type === 'long_text') return `<div class="whitespace-pre-wrap">${esc(v)}</div>`;
  return esc(answerToText(q, v));
}

export async function renderSubmissions(assignment, router, container) {
  const a = assignment;
  const courseId = a.gradebook?.course_id || a.class_id || null;

  let course = null;
  let roster = [];
  let submissions = [];
  let viewMode = 'students'; // 'students' | 'speedgrader' | 'item_analysis'
  let speedgraderQIndex = 0;
  let blindGrading = false;
  let fingerprintCounts = new Map();

  const load = async () => {
    [course, roster, submissions] = await Promise.all([
      courseId ? storage.table('gradebook_courses').get(courseId) : null,
      courseId ? storage.table('gradebook_students').where('course_id').equals(courseId).toArray().catch(() => []) : [],
      storage.table('assignment_submissions').where('assignment_id').equals(a.id).toArray().catch(() => [])
    ]);
    roster.sort((x, y) => (x.full_name || '').localeCompare(y.full_name || ''));

    for (let i = 0; i < submissions.length; i++) {
      const sub = submissions[i];
      const updated = await reconcileSubmissionWithAssignment(sub, a, roster);
      if (updated.auto?.earned !== sub.auto?.earned ||
          updated.auto?.possible !== sub.auto?.possible ||
          updated.identity !== sub.identity ||
          updated.student_id !== sub.student_id ||
          updated.student_name !== sub.student_name ||
          (updated.archived_answers && Object.keys(updated.archived_answers).length !== Object.keys(sub.archived_answers || {}).length)) {
        submissions[i] = updated;
        await storage.table('assignment_submissions').put(updated);
      }
    }
  };

  const latestFor = (studentId) => submissions
    .filter(s => s.is_latest !== false && String(s.student_id).toUpperCase() === String(studentId).toUpperCase())
    .sort((x, y) => (y.submitted_at || '').localeCompare(x.submitted_at || ''))[0] || null;

  let filterMode = 'all'; // 'all' | 'submitted' | 'not_submitted'

  const renderSpeedgraderView = (latest) => {
    const questions = a.questions || [];
    if (!questions.length) {
      return `<div class="p-10 text-center text-slate-500 bg-white rounded-2xl border border-slate-200">This assignment has no questions.</div>`;
    }
    if (speedgraderQIndex < 0 || speedgraderQIndex >= questions.length) speedgraderQIndex = 0;
    const q = questions[speedgraderQIndex];
    const meta = QUESTION_TYPE_META[q.type] || {};

    const qPills = questions.map((question, idx) => {
      const pendingCount = latest.filter(s => {
        const auto = s.auto?.per_question?.[question.id];
        const m = s.manual?.[question.id];
        return auto?.needs_manual && (m?.points === undefined || m?.points === null);
      }).length;
      const isSelected = idx === speedgraderQIndex;
      return `
        <button type="button" class="speedgrader-q-btn px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all ${isSelected ? 'bg-amber-500 text-white shadow-xs' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}" data-q-index="${idx}">
          <span>Q${idx + 1}</span>
          ${pendingCount ? `<span class="px-1.5 py-0.2 rounded-full text-[10px] ${isSelected ? 'bg-amber-600 text-white' : 'bg-amber-100 text-amber-800 font-bold'}">${pendingCount}</span>` : ''}
        </button>`;
    }).join('');

    const sortedSubmissions = [...latest].sort((x, y) => (x.student_name || x.student_id || '').localeCompare(y.student_name || y.student_id || ''));

    const responseCards = sortedSubmissions.map((sub, sIdx) => {
      const auto = sub.auto?.per_question?.[q.id] || { earned: 0, possible: q.points || 0, needs_manual: q.type === 'long_text' };
      const m = sub.manual?.[q.id] || {};
      const tone = auto.needs_manual ? 'border-amber-300' : auto.correct ? 'border-emerald-200' : auto.earned > 0 ? 'border-blue-200' : 'border-rose-200';
      const displayName = blindGrading ? `Student #${sIdx + 1}` : esc(sub.student_name || sub.claimed_name || sub.student_id);
      const displayId = blindGrading ? '' : `<span class="text-xs text-slate-400 tabular-nums ml-2">${esc(sub.student_id)}</span>`;

      return `
        <div class="bg-white rounded-xl border ${tone} p-4 space-y-3" data-speedgrader-sub="${esc(sub.id)}" data-speedgrader-qid="${esc(q.id)}">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-slate-900">${displayName}</span>
              ${displayId}
              ${!blindGrading ? identityChip(sub.identity) : ''}
            </div>
            <span class="text-xs font-semibold tabular-nums ${auto.needs_manual ? 'text-amber-700' : 'text-slate-500'}">
              ${auto.needs_manual ? 'Needs review' : `Auto: ${auto.earned} / ${auto.possible}`}
            </span>
          </div>
          <div class="p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-800">
            <div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Student Answer</div>
            <div>${formatAnswer(q, sub.answers?.[q.id])}</div>
          </div>
          <div class="flex flex-col sm:flex-row gap-3">
            <sl-input size="small" type="number" min="0" max="${auto.possible}" step="0.5" class="sm:w-36" data-sg-points label="Points" placeholder="${auto.needs_manual ? '' : `${auto.earned} (auto)`}" value="${m.points ?? ''}" help-text="${auto.needs_manual ? 'Required' : 'Leave empty to keep auto'}">
              <span slot="suffix" class="text-xs text-slate-400">/ ${auto.possible}</span>
            </sl-input>
            <sl-textarea size="small" rows="1" resize="auto" class="flex-1" data-sg-feedback label="Feedback" placeholder="Optional notes for the student" value="${esc(m.feedback || '')}"></sl-textarea>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
          <div class="flex items-center gap-1.5 flex-wrap overflow-x-auto py-1">
            ${qPills}
          </div>
          <div class="flex items-center gap-3 flex-shrink-0">
            <sl-switch id="speedgrader-blind" ${blindGrading ? 'checked' : ''} class="text-xs font-medium text-slate-700">Blind Grading</sl-switch>
            <div class="flex items-center gap-1">
              <sl-button size="small" id="speedgrader-prev-q" ${speedgraderQIndex === 0 ? 'disabled' : ''}><sl-icon slot="prefix" name="chevron-left"></sl-icon> Prev</sl-button>
              <sl-button size="small" id="speedgrader-next-q" ${speedgraderQIndex >= questions.length - 1 ? 'disabled' : ''}>Next <sl-icon slot="suffix" name="chevron-right"></sl-icon></sl-button>
            </div>
          </div>
        </div>

        <div class="bg-amber-50/50 rounded-2xl border border-amber-200 p-5 space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="font-bold text-slate-900 text-base">Question ${speedgraderQIndex + 1} of ${questions.length}</span>
              <span class="text-xs px-2 py-0.5 rounded-full bg-white border border-slate-200 text-slate-700 font-medium flex items-center gap-1"><sl-icon name="${meta.icon || 'question'}"></sl-icon>${esc(meta.label || q.type)}</span>
            </div>
            <span class="text-sm font-semibold text-slate-700 tabular-nums">${q.points || 1} pt${(q.points || 1) === 1 ? '' : 's'}</span>
          </div>
          <div class="text-sm text-slate-900 kb-prose [&_p]:m-0">${Sanitizer.renderSTEMMarkdown(String(q.prompt || '').replace(BLANK_TOKEN, '____'))}</div>
          <div class="text-xs text-slate-600 bg-white p-3 rounded-xl border border-amber-200">
            <strong>${q.type === 'long_text' ? 'Grading notes / rubric:' : 'Answer key:'}</strong> ${esc(q.type === 'long_text' ? (q.rubric_hint || '—') : describeCorrectAnswer(q))}
          </div>
        </div>

        <div class="space-y-3">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider flex justify-between items-center">
            <span>Student Responses (${sortedSubmissions.length})</span>
            <span class="text-[11px] text-slate-400">Edits save automatically</span>
          </div>
          ${sortedSubmissions.length ? responseCards : '<div class="p-8 text-center text-slate-400 bg-white rounded-xl border border-slate-200">No submissions yet for this question.</div>'}
        </div>
      </div>`;
  };

  const renderItemAnalysisView = (latest) => {
    if (!latest.length) {
      return `<div class="p-10 text-center text-slate-500 bg-white rounded-2xl border border-slate-200">No submissions yet to analyze.</div>`;
    }
    const questions = a.questions || [];
    if (!questions.length) {
      return `<div class="p-10 text-center text-slate-500 bg-white rounded-2xl border border-slate-200">This assignment has no questions.</div>`;
    }

    const items = questions.map((q, idx) => {
      const meta = QUESTION_TYPE_META[q.type] || {};
      const totalSub = latest.length;
      let earnedSum = 0;
      let correctCount = 0;
      const choiceCounts = {};
      if (Array.isArray(q.options)) {
        q.options.forEach(opt => { choiceCounts[opt.id] = 0; });
      } else if (q.type === 'true_false') {
        choiceCounts['true'] = 0;
        choiceCounts['false'] = 0;
      }
      const textAnswers = {};

      latest.forEach(s => {
        const auto = s.auto?.per_question?.[q.id] || { earned: 0, possible: q.points || 0 };
        const m = s.manual?.[q.id];
        const earned = (m?.points !== undefined && m?.points !== null) ? Number(m.points) : (auto.earned || 0);
        earnedSum += earned;
        if (auto.correct || earned >= (q.points || 1)) correctCount++;

        const ans = s.answers?.[q.id];
        if (q.type === 'single_choice' || q.type === 'true_false') {
          const k = String(ans ?? '');
          if (choiceCounts[k] !== undefined) choiceCounts[k]++;
        } else if (q.type === 'multi_choice' && Array.isArray(ans)) {
          ans.forEach(k => { if (choiceCounts[k] !== undefined) choiceCounts[k]++; });
        } else if (q.type === 'short_text' && typeof ans === 'string' && ans.trim()) {
          const norm = ans.trim().toLowerCase();
          textAnswers[norm] = (textAnswers[norm] || 0) + 1;
        }
      });

      const avgPts = totalSub ? (earnedSum / totalSub).toFixed(1) : 0;
      const facilityIndex = totalSub ? Math.round((correctCount / totalSub) * 100) : 0;
      const facilityTone = facilityIndex >= 70 ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : facilityIndex >= 40 ? 'bg-blue-100 text-blue-800 border-blue-300' : 'bg-rose-100 text-rose-800 border-rose-300';
      const facilityLabel = facilityIndex >= 70 ? 'High Mastery' : facilityIndex >= 40 ? 'Moderate' : 'Challenging / Low Mastery';

      let distractorWarning = '';
      if ((q.type === 'single_choice' || q.type === 'true_false') && q.options) {
        for (const opt of q.options) {
          if (!opt.correct && choiceCounts[opt.id] > 0) {
            const optPct = Math.round((choiceCounts[opt.id] / totalSub) * 100);
            if (optPct >= 30) {
              distractorWarning += `<div class="mt-2 text-xs p-2 rounded bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1.5"><sl-icon name="exclamation-triangle" class="text-amber-600"></sl-icon> <strong>Distractor Alert:</strong> ${optPct}% of students picked incorrect option “${esc(opt.text)}”.</div>`;
            }
          }
        }
      }

      let choiceBarsHtml = '';
      if (Array.isArray(q.options) && q.options.length) {
        choiceBarsHtml = `
          <div class="space-y-2 mt-3 pt-3 border-t border-slate-100">
            <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Option Distribution</div>
            ${q.options.map(opt => {
              const count = choiceCounts[opt.id] || 0;
              const pct = totalSub ? Math.round((count / totalSub) * 100) : 0;
              const isCorrect = Boolean(opt.correct);
              return `
                <div class="space-y-1">
                  <div class="flex justify-between text-xs">
                    <span class="flex items-center gap-1.5 ${isCorrect ? 'font-semibold text-emerald-800' : 'text-slate-700'}">
                      ${isCorrect ? '<sl-icon name="check-circle-fill" class="text-emerald-600"></sl-icon>' : '<sl-icon name="circle" class="text-slate-300"></sl-icon>'}
                      ${esc(opt.text)}
                    </span>
                    <span class="tabular-nums text-slate-500">${count} (${pct}%)</span>
                  </div>
                  <div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div class="h-full rounded-full transition-all ${isCorrect ? 'bg-emerald-500' : 'bg-slate-300'}" style="width: ${pct}%"></div>
                  </div>
                </div>`;
            }).join('')}
          </div>`;
      }

      let topShortHtml = '';
      if (q.type === 'short_text' && Object.keys(textAnswers).length) {
        const sorted = Object.entries(textAnswers).sort((a, b) => b[1] - a[1]).slice(0, 5);
        topShortHtml = `
          <div class="space-y-1.5 mt-3 pt-3 border-t border-slate-100">
            <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Top Submitted Answers</div>
            <div class="flex flex-wrap gap-2">
              ${sorted.map(([txt, cnt]) => `
                <span class="px-2 py-1 rounded bg-slate-100 text-xs text-slate-700 font-mono">
                  "${esc(txt)}" <span class="text-slate-400 font-sans tabular-nums">(${cnt})</span>
                </span>`).join('')}
            </div>
          </div>`;
      }

      return `
        <div class="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 shadow-xs">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <span class="font-bold text-slate-900">Q${idx + 1}.</span>
              <span class="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium flex items-center gap-1"><sl-icon name="${meta.icon || 'question'}"></sl-icon>${esc(meta.label || q.type)}</span>
              <span class="text-xs text-slate-400 tabular-nums">${q.points || 1} pt${(q.points || 1) === 1 ? '' : 's'}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs px-2 py-1 rounded-full border font-semibold ${facilityTone}">${facilityIndex}% · ${facilityLabel}</span>
              <span class="text-xs text-slate-500">Avg: <strong class="text-slate-900">${avgPts}</strong> / ${q.points || 1}</span>
            </div>
          </div>
          <div class="text-sm text-slate-800 kb-prose [&_p]:m-0">${Sanitizer.renderSTEMMarkdown(String(q.prompt || '').replace(BLANK_TOKEN, '____'))}</div>
          ${distractorWarning}
          ${choiceBarsHtml}
          ${topShortHtml}
        </div>`;
    }).join('');

    return `<div class="space-y-4">${items}</div>`;
  };

  const render = () => {
    const latest = submissions.filter(s => s.is_latest !== false);
    const rosterIds = new Set(roster.map(s => String(s.student_id).toUpperCase()));
    const strangers = latest.filter(s => !rosterIds.has(String(s.student_id).toUpperCase()));
    const notSubmitted = roster.filter(s => !latestFor(s.student_id));
    const scores = latest.map(s => finalScore(a, s));
    const maxPts = totalPoints(a);
    const avg = scores.length ? Math.round((scores.reduce((t, s) => t + (s.possible ? s.earned / s.possible : 0), 0) / scores.length) * 100) : null;
    const pendingReview = scores.filter(s => s.pending > 0).length;
    const warnings = latest.filter(s => s.identity !== 'verified').length;
    const unsynced = latest.filter(s => !s.synced_at || (s.updated_at && s.updated_at > s.synced_at)).length;

    fingerprintCounts = new Map();
    latest.forEach(s => {
      if (s.answers_fingerprint) {
        const set = fingerprintCounts.get(s.answers_fingerprint) || new Set();
        set.add(String(s.student_id).toUpperCase());
        fingerprintCounts.set(s.answers_fingerprint, set);
      }
    });

    const row = (student, sub) => {
      const score = sub ? finalScore(a, sub) : null;
      const isDuplicate = sub?.answers_fingerprint && (fingerprintCounts.get(sub.answers_fingerprint)?.size > 1);
      const status = !sub
        ? '<span class="inline-flex items-center gap-1 text-xs text-slate-400"><sl-icon name="circle"></sl-icon>Not submitted</span>'
        : `<span class="inline-flex items-center gap-1 text-xs text-slate-700"><sl-icon name="check-circle-fill" class="text-emerald-600"></sl-icon>Submitted</span>${sub.days_late ? ` <span class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700">${sub.days_late}d LATE</span>` : ''}${isDuplicate ? ` <span class="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 inline-flex items-center gap-1" title="Identical answer set detected across multiple students"><sl-icon name="copy"></sl-icon>DUPLICATE</span>` : ''}`;
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

    let displayRows = [];
    if (filterMode === 'submitted') {
      displayRows = [
        ...roster.filter(s => latestFor(s.student_id)).map(s => row(s, latestFor(s.student_id))),
        ...strangers.map(sub => row(null, sub))
      ];
    } else if (filterMode === 'not_submitted') {
      displayRows = notSubmitted.map(s => row(s, null));
    } else {
      displayRows = [
        ...roster.map(s => row(s, latestFor(s.student_id))),
        ...strangers.map(sub => row(null, sub))
      ];
    }

    let mainContentHtml = '';
    if (viewMode === 'speedgrader') {
      mainContentHtml = renderSpeedgraderView(latest);
    } else if (viewMode === 'item_analysis') {
      mainContentHtml = renderItemAnalysisView(latest);
    } else {
      mainContentHtml = `
        <div class="space-y-3">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div class="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs">
              <button type="button" class="px-3 py-1.5 rounded-lg font-medium ${filterMode === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}" id="btn-filter-all">
                All (${roster.length || latest.length})
              </button>
              <button type="button" class="px-3 py-1.5 rounded-lg font-medium ${filterMode === 'submitted' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}" id="btn-filter-submitted">
                Submitted (${latest.length})
              </button>
              <button type="button" class="px-3 py-1.5 rounded-lg font-medium ${filterMode === 'not_submitted' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'}" id="btn-filter-not-submitted">
                Not submitted (${notSubmitted.length})
              </button>
            </div>
            ${filterMode === 'not_submitted' && notSubmitted.length > 0 ? `
              <sl-button size="small" id="btn-export-not-submitted">
                <sl-icon slot="prefix" name="file-earmark-spreadsheet"></sl-icon> Export not-submitted list (CSV)
              </sl-button>
            ` : ''}
          </div>

          <div class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            ${displayRows.length ? `
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
                    ${displayRows.join('')}
                  </tbody>
                </table>
              </div>` : `
              <div class="p-10 text-center space-y-3">
                <span class="w-12 h-12 mx-auto rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center text-2xl"><sl-icon name="inbox"></sl-icon></span>
                <h3 class="font-semibold text-slate-900">${filterMode === 'not_submitted' ? 'Everyone has submitted!' : 'No submissions yet'}</h3>
                <p class="text-sm text-slate-500 max-w-md mx-auto">${filterMode === 'not_submitted' ? 'All students on this roster have handed in their work.' : 'Students download a <code>.kbsub</code> file or copy a submission code when they finish. Import the files or paste the codes here.'}</p>
              </div>`}
          </div>
        </div>`;
    }

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
            ${a.publish?.relay?.drop_id ? `
              <sl-button size="small" variant="primary" id="sub-pull-relay"><sl-icon slot="prefix" name="cloud-arrow-down"></sl-icon> Pull from Server</sl-button>
            ` : ''}
            <sl-button size="small" id="sub-scan-qr" variant="primary"><sl-icon slot="prefix" name="camera"></sl-icon> Scan QR</sl-button>
            <sl-button size="small" href="#/inbox"><sl-icon slot="prefix" name="inbox"></sl-icon> Open Inbox</sl-button>
            <sl-button size="small" id="sub-paste"><sl-icon slot="prefix" name="clipboard-plus"></sl-icon> Paste codes</sl-button>
            <sl-button size="small" id="sub-import"><sl-icon slot="prefix" name="upload"></sl-icon> Import .kbsub files</sl-button>
            <sl-button size="small" variant="neutral" id="sub-return-feedback"><sl-icon slot="prefix" name="reply-all"></sl-icon> Return feedback</sl-button>
            <sl-button size="small" variant="primary" id="sub-sync" ${!course || !latest.length ? 'disabled' : ''}><sl-icon slot="prefix" name="journal-arrow-up"></sl-icon> Sync to gradebook${unsynced ? ` (${unsynced})` : ''}</sl-button>
            <input type="file" id="sub-file" accept=".kbsub,.txt,.json" multiple class="hidden" />
          </div>
        </div>

        ${roster.length ? `
          <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs space-y-2">
            <div class="flex justify-between text-xs text-slate-600 font-medium">
              <span>Collected <strong>${latest.length}</strong> of <strong>${roster.length}</strong> roster submissions</span>
              <span class="tabular-nums font-semibold text-amber-700">${Math.round((latest.length / roster.length) * 100)}%</span>
            </div>
            <div class="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
              <div class="h-full bg-amber-500 rounded-full transition-all duration-300" style="width: ${Math.min(100, Math.round((latest.length / roster.length) * 100))}%"></div>
            </div>
          </div>
        ` : ''}

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

        <div class="flex items-center gap-2 border-b border-slate-200 pb-3">
          <button type="button" class="px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all ${viewMode === 'students' ? 'bg-amber-500 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}" id="tab-mode-students">
            <sl-icon name="people"></sl-icon> By Student (${latest.length})
          </button>
          <button type="button" class="px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all ${viewMode === 'speedgrader' ? 'bg-amber-500 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}" id="tab-mode-speedgrader">
            <sl-icon name="lightning-charge"></sl-icon> SpeedGrader (By Question)
          </button>
          <button type="button" class="px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all ${viewMode === 'item_analysis' ? 'bg-amber-500 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}" id="tab-mode-item-analysis">
            <sl-icon name="bar-chart-line"></sl-icon> Item Analysis
          </button>
        </div>

        ${mainContentHtml}
      </div>`;

    bind(notSubmitted);
  };

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------
  async function importTexts(texts) {
    const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
    const res = await importSubmissionTexts({ assignment: a, texts, roster, keys });
    await load();
    render();
    if (res.added) toast.success(`Imported ${res.added} submission${res.added === 1 ? '' : 's'}.`);
    if (res.duplicates) toast.info(`${res.duplicates} already imported.`);
    if (res.errors.length) showImportErrors(res.errors);
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

    const isDuplicate = sub?.answers_fingerprint && (fingerprintCounts.get(sub.answers_fingerprint)?.size > 1);
    const studentSubs = submissions
      .filter(s => String(s.student_id).toUpperCase() === String(sub.student_id).toUpperCase())
      .sort((x, y) => (x.submitted_at || '').localeCompare(y.submitted_at || ''));

    const scoreLine = () => {
      const s = finalScore(a, { ...sub, manual: draft.manual });
      return `<span class="text-2xl font-bold text-slate-900 tabular-nums">${s.earned}</span><span class="text-slate-400"> / ${s.possible} pts</span>${s.pending ? `<span class="ml-2 text-xs text-amber-700">${s.pending} still to grade</span>` : ''}`;
    };

    drawer.innerHTML = `
      <div class="space-y-5">
        <div class="flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl bg-slate-50 border border-slate-200">
          <div class="space-y-1">
            <div class="flex items-center gap-2 flex-wrap">
              ${identityChip(sub.identity)}
              ${sub.days_late ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700">${sub.days_late}d LATE</span>` : ''}
              ${sub.stale_version ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-700" title="Submitted against an earlier published version; re-graded with the current key.">OLDER VERSION</span>' : ''}
              ${isDuplicate ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 inline-flex items-center gap-1" title="Identical answer set detected across multiple students"><sl-icon name="copy"></sl-icon>DUPLICATE ANSWERS</span>' : ''}
            </div>
            <div class="text-xs text-slate-500">${esc(sub.student_id)} · submitted ${esc(new Date(sub.submitted_at).toLocaleString())}${sub.claimed_name && sub.claimed_name !== sub.student_name ? ` · typed name “${esc(sub.claimed_name)}”` : ''}</div>
            ${sub.identity !== 'verified' ? `<div class="text-xs text-rose-700">${esc(IDENTITY_LABELS[sub.identity]?.help || '')}</div>` : ''}
          </div>
          <div class="flex flex-col items-end gap-2">
            <div id="review-score">${scoreLine()}</div>
            ${studentSubs.length > 1 ? `
              <div class="flex items-center gap-1 text-xs bg-slate-200/70 p-1 rounded-lg">
                <span class="text-slate-600 font-medium px-1">Attempts:</span>
                ${studentSubs.map((s, idx) => `
                  <button type="button" class="attempt-switch-btn px-2 py-0.5 rounded font-semibold text-xs transition-all ${s.id === sub.id ? 'bg-white shadow-xs text-amber-800' : 'text-slate-600 hover:text-slate-900'}" data-attempt-id="${esc(s.id)}">
                    #${idx + 1}${s.is_latest !== false ? ' (Latest)' : ''}
                  </button>
                `).join('')}
              </div>` : ''}
          </div>
        </div>

        ${sub.identity === 'suggested_match' && sub.suggested_student ? `
          <div class="p-4 bg-indigo-50 border border-indigo-200 rounded-xl flex items-center justify-between gap-3 text-sm">
            <div>
              <div class="font-semibold text-indigo-900 flex items-center gap-1.5"><sl-icon name="person-check"></sl-icon> Suggested student match</div>
              <div class="text-indigo-800 text-xs mt-0.5">${esc(sub.suggested_student.full_name || sub.suggested_student.name)} (${esc(sub.suggested_student.student_id)})</div>
            </div>
            <sl-button size="small" variant="primary" id="review-link-suggested"><sl-icon slot="prefix" name="link"></sl-icon> Link student</sl-button>
          </div>
        ` : ''}

        ${sub.identity === 'not_in_roster' && course ? `
          <div class="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between gap-3 text-xs">
            <span class="text-amber-800">Student ID "${esc(sub.student_id)}" is not in this class roster.</span>
            <sl-button size="small" id="review-add-roster"><sl-icon slot="prefix" name="person-plus"></sl-icon> Add to roster</sl-button>
          </div>
        ` : ''}

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
      <div slot="footer" class="flex flex-wrap items-center justify-between gap-2 w-full">
        <div class="flex items-center gap-2 flex-wrap">
          <sl-button size="small" id="review-show-feedback-qr" variant="primary"><sl-icon slot="prefix" name="qr-code-scan"></sl-icon> Show QR</sl-button>
          <sl-button size="small" id="review-copy-feedback-link"><sl-icon slot="prefix" name="link-45deg"></sl-icon> Copy link</sl-button>
          <sl-button size="small" id="review-download-feedback-html"><sl-icon slot="prefix" name="file-earmark-code"></sl-icon> Download (.html)</sl-button>
        </div>
        <div class="flex items-center gap-2">
          <sl-button id="review-cancel">Cancel</sl-button>
          <sl-button id="review-save">Save</sl-button>
          <sl-button variant="primary" id="review-save-sync" ${course && roster.some(r => String(r.student_id).toUpperCase() === String(sub.student_id).toUpperCase()) ? '' : 'disabled'}><sl-icon slot="prefix" name="journal-arrow-up"></sl-icon> Save &amp; sync</sl-button>
        </div>
      </div>`;

    document.body.appendChild(drawer);
    drawer.addEventListener('sl-after-hide', (e) => { if (e.target === drawer) drawer.remove(); });
    drawer.show();

    drawer.querySelectorAll('.attempt-switch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = studentSubs.find(s => s.id === btn.dataset.attemptId);
        if (target) {
          drawer.hide();
          setTimeout(() => openReview(target), 120);
        }
      });
    });

    drawer.querySelector('#review-show-feedback-qr')?.addEventListener('click', async () => {
      try {
        const student = roster.find(r => String(r.student_id).toUpperCase() === String(sub.student_id).toUpperCase());
        const link = await createFeedbackLink({ assignment: a, submission: { ...sub, manual: draft.manual, feedback: draft.feedback }, student, course });
        const { showQrSequence } = await import('../../components/qr-handoff.js');
        const sName = sub.student_name || sub.claimed_name || sub.student_id || 'Student';
        showQrSequence(link.url, {
          title: `Feedback · ${sName}`,
          intro: `Encrypted feedback for ${sName}. The student can scan this from their camera or Student Hub to see their grade.`,
          preferDirectUrl: true
        });
      } catch (err) {
        toast.danger('Could not create feedback QR: ' + err.message);
      }
    });

    drawer.querySelector('#review-copy-feedback-link')?.addEventListener('click', async () => {
      try {
        const student = roster.find(r => String(r.student_id).toUpperCase() === String(sub.student_id).toUpperCase());
        const link = await createFeedbackLink({ assignment: a, submission: { ...sub, manual: draft.manual, feedback: draft.feedback }, student, course });
        await navigator.clipboard.writeText(link.url);
        toast.success('Feedback link copied to clipboard!');
      } catch (err) {
        toast.danger('Could not create feedback link: ' + err.message);
      }
    });

    drawer.querySelector('#review-download-feedback-html')?.addEventListener('click', async () => {
      try {
        const student = roster.find(r => String(r.student_id).toUpperCase() === String(sub.student_id).toUpperCase());
        const link = await createFeedbackLink({ assignment: a, submission: { ...sub, manual: draft.manual, feedback: draft.feedback }, student, course });
        const { downloadClickableHtmlFile } = await import('../../core/html-launcher.js');
        const studentName = sub.student_name || sub.claimed_name || sub.student_id || 'Student';
        const cleanName = `${a.title || 'feedback'}_${studentName}`.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
        downloadClickableHtmlFile({
          title: `Feedback: ${a.title || 'Assignment'}`,
          payloadType: 'feedback',
          payload: JSON.parse(link.rawFileContent),
          studentName,
          studentId: sub.student_id,
          shareUrl: link.url
        }, `${cleanName}.kbfeedback.html`);
        toast.success('Downloaded feedback launcher file (.kbfeedback.html)!');
      } catch (err) {
        toast.danger('Could not download feedback file: ' + err.message);
      }
    });

    drawer.querySelector('#review-link-suggested')?.addEventListener('click', async () => {
      const suggested = sub.suggested_student;
      if (!suggested) return;
      sub.student_id = suggested.student_id;
      sub.student_name = suggested.full_name || suggested.name;
      sub.identity = suggested.access_code ? 'verified' : 'no_code_on_file';
      sub.suggested_student = null;
      sub.updated_at = new Date().toISOString();
      await storage.table('assignment_submissions').put(sub);
      if (courseId) {
        await StudentMatcher.addStudentAlias(suggested.student_id, courseId, sub.claimed_name || sub.student_id);
      }
      drawer.hide();
      toast.success(`Linked submission to ${suggested.full_name || suggested.name}`);
      await load();
      render();
    });

    drawer.querySelector('#review-add-roster')?.addEventListener('click', async () => {
      if (!courseId) return;
      const newStudent = {
        id: crypto.randomUUID(),
        course_id: courseId,
        student_id: sub.student_id,
        full_name: sub.claimed_name || sub.student_name || sub.student_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      await storage.table('gradebook_students').put(newStudent);
      sub.student_name = newStudent.full_name;
      sub.identity = 'no_code_on_file';
      sub.updated_at = new Date().toISOString();
      await storage.table('assignment_submissions').put(sub);
      drawer.hide();
      toast.success(`Added ${newStudent.full_name} to class roster.`);
      await load();
      render();
    });

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

        let feedbackLinkUrl = undefined;
        try {
          const fbRes = await createFeedbackLink({ assignment: a, submission: sub, student, course });
          feedbackLinkUrl = fbRes?.url;
        } catch (_) {}

        await GradebookBridge.writeGrade({
          courseId: course.id,
          assignmentId: column.id,
          studentId: student.student_id,
          rawScore: s.earned,
          status: sub.days_late > 0 ? 'late' : 'submitted',
          feedback: feedbackSummary(a, sub),
          extra: {
            days_late: sub.days_late || undefined,
            source_submission_id: sub.id,
            feedback_link: feedbackLinkUrl
          }
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
  // Return Feedback Dialog & Exports
  // ---------------------------------------------------------------------------
  async function openReturnFeedbackDialog(notSubmitted = []) {
    const latest = submissions.filter(s => s.is_latest !== false);

    let publishedUrl = '';
    try {
      const keys = await replication.publishKeysFor(a.class_id);
      let rosterChecks = null;
      if (a.settings?.require_access_code && roster.length) {
        rosterChecks = {};
        for (const s of roster.filter(s => s.access_code)) {
          rosterChecks[String(s.student_id).toUpperCase()] = await SubmissionCrypto.accessCodeCheck(a.id, s.student_id, s.access_code);
        }
      }
      const payload = await buildStudentPayload(a, { teacherKeys: keys, rosterChecks });
      const share = await CryptoShareEngine.createSharePayload('assignment', payload, '');
      publishedUrl = share.url;
    } catch (_) {}

    const baseTakeUrl = publishedUrl || `${window.location.origin}${window.location.pathname}#/assessments/take`;
    const assignmentLinksMap = {};
    roster.forEach(s => {
      const fullName = s.full_name || `${s.given_name || ''} ${s.family_name || ''}`.trim();
      assignmentLinksMap[s.student_id] = LinkBuilder.withParams(baseTakeUrl, { sid: s.student_id, sname: fullName });
    });

    const cleanTitle = (a.title || 'assignment').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 30);

    const presets = [
      {
        id: 'mail_merge',
        label: 'Mail-merge CSV (with encrypted feedback links)',
        description: 'One row per student on the roster. Includes individual encrypted feedback links for submitted work and assignment links for reminders.',
        supportsAccessCodes: true,
        build: async (opts) => {
          const feedbackLinksMap = {};
          for (const sub of latest) {
            const student = roster.find(r => String(r.student_id).toUpperCase() === String(sub.student_id).toUpperCase()) || {
              student_id: sub.student_id,
              full_name: sub.student_name
            };
            try {
              const { url } = await createFeedbackLink({
                assignment: a,
                submission: sub,
                student,
                course
              });
              feedbackLinksMap[student.student_id] = url;
              feedbackLinksMap[String(student.student_id).toUpperCase()] = url;
            } catch (e) {
              console.error('Error creating feedback link for student:', student.student_id, e);
            }
          }

          const { headers, rows } = buildMailMergeExportRows({
            assignment: a,
            submissions: latest,
            roster: roster.length ? roster : latest.map(s => ({ student_id: s.student_id, full_name: s.student_name })),
            course,
            feedbackLinksMap,
            assignmentLinksMap,
            includeAccessCodes: opts.includeAccessCodes
          });
          return { headers, rows, filename: `${cleanTitle}_mail_merge.csv` };
        }
      },
      {
        id: 'submissions',
        label: 'Submissions CSV (grades & question scores)',
        description: 'One row per latest submission with identity status, final score, percentage, and teacher comments.',
        supportsQuestions: true,
        build: async (opts) => {
          const { headers, rows } = buildSubmissionsExportRows({
            assignment: a,
            submissions: latest,
            roster,
            course,
            includeQuestions: opts.includeQuestions
          });
          return { headers, rows, filename: `${cleanTitle}_submissions.csv` };
        }
      },
      {
        id: 'lms_comments',
        label: 'Copy feedback for LMS comments',
        description: 'Tab-delimited table of Student ID, Name, and feedback text for quick pasting into LMS gradebook comments.',
        build: async () => {
          const rows = latest.map(sub => {
            const student = roster.find(r => String(r.student_id).toUpperCase() === String(sub.student_id).toUpperCase());
            return {
              StudentID: sub.student_id,
              FullName: student?.full_name || sub.student_name || '',
              Feedback: feedbackSummary(a, sub)
            };
          });
          return { headers: ['StudentID', 'FullName', 'Feedback'], rows, filename: `${cleanTitle}_lms_comments.tsv` };
        }
      },
      {
        id: 'feedback_pdfs',
        label: 'Feedback PDFs (ZIP package)',
        description: 'Generates one standalone PDF report per submission formatted with student work, scores, and teacher comments.',
        customAction: {
          label: 'Download ZIP',
          icon: 'file-earmark-zip',
          run: async () => {
            toast.info('Generating feedback PDFs...');
            const { blob, count, filename } = await generateFeedbackZip({
              assignment: a,
              submissions: latest,
              roster,
              course
            });
            downloadBlob(blob, filename);
            toast.success(`Downloaded ${count} PDF reports in ${filename}`);
          }
        },
        build: async () => {
          const rows = latest.map(sub => {
            const student = roster.find(r => String(r.student_id).toUpperCase() === String(sub.student_id).toUpperCase());
            const score = finalScore(a, sub);
            return {
              StudentID: sub.student_id,
              FullName: student?.full_name || sub.student_name || '',
              Score: `${score.earned} / ${score.possible}`,
              PDF_File: `${sub.student_id}_${cleanTitle}.pdf`
            };
          });
          return { headers: ['StudentID', 'FullName', 'Score', 'PDF_File'], rows, filename: `pdf_manifest.csv` };
        }
      },
      {
        id: 'not_submitted',
        label: 'Not submitted list (CSV for reminders)',
        description: 'One row per rostered student who has not submitted yet, with personalized direct assignment link.',
        build: async () => {
          const { headers, rows } = buildNotSubmittedExportRows({
            assignment: a,
            roster: notSubmitted,
            assignmentLinksMap
          });
          return { headers, rows, filename: `${cleanTitle}_not_submitted.csv` };
        }
      }
    ];

    await ExportDialog.open({
      title: `Return Feedback · ${a.title}`,
      presets
    });
  }

  // ---------------------------------------------------------------------------
  // Bindings
  // ---------------------------------------------------------------------------
  function bind(notSubmitted = []) {
    container.querySelector('#sub-back')?.addEventListener('click', () => router.navigate(`#/assessments/edit?id=${a.id}`));
    container.querySelector('#sub-paste')?.addEventListener('click', openPasteDialog);
    container.querySelector('#sub-return-feedback')?.addEventListener('click', () => openReturnFeedbackDialog(notSubmitted));
    container.querySelector('#btn-filter-all')?.addEventListener('click', () => { filterMode = 'all'; render(); });
    container.querySelector('#btn-filter-submitted')?.addEventListener('click', () => { filterMode = 'submitted'; render(); });
    container.querySelector('#btn-filter-not-submitted')?.addEventListener('click', () => { filterMode = 'not_submitted'; render(); });

    container.querySelector('#tab-mode-students')?.addEventListener('click', () => { viewMode = 'students'; render(); });
    container.querySelector('#tab-mode-speedgrader')?.addEventListener('click', () => { viewMode = 'speedgrader'; render(); });
    container.querySelector('#tab-mode-item-analysis')?.addEventListener('click', () => { viewMode = 'item_analysis'; render(); });

    if (viewMode === 'speedgrader') {
      container.querySelectorAll('.speedgrader-q-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          speedgraderQIndex = Number(btn.dataset.qIndex);
          render();
        });
      });
      container.querySelector('#speedgrader-prev-q')?.addEventListener('click', () => {
        if (speedgraderQIndex > 0) { speedgraderQIndex--; render(); }
      });
      container.querySelector('#speedgrader-next-q')?.addEventListener('click', () => {
        const qCount = a.questions?.length || 0;
        if (speedgraderQIndex < qCount - 1) { speedgraderQIndex++; render(); }
      });
      container.querySelector('#speedgrader-blind')?.addEventListener('sl-change', (e) => {
        blindGrading = e.target.checked;
        render();
      });
      container.querySelectorAll('[data-speedgrader-sub]').forEach(card => {
        const subId = card.dataset.speedgraderSub;
        const qid = card.dataset.speedgraderQid;
        const sub = submissions.find(s => s.id === subId);
        if (!sub) return;

        const pointsInput = card.querySelector('[data-sg-points]');
        const feedbackInput = card.querySelector('[data-sg-feedback]');

        const saveSG = async () => {
          if (!sub.manual) sub.manual = {};
          const pts = pointsInput.value === '' ? null : Number(pointsInput.value);
          const fb = feedbackInput.value || '';
          sub.manual[qid] = { ...(sub.manual[qid] || {}), points: pts, feedback: fb };
          sub.updated_at = new Date().toISOString();
          await storage.table('assignment_submissions').put(sub);
        };

        pointsInput?.addEventListener('sl-change', saveSG);
        feedbackInput?.addEventListener('sl-change', saveSG);
      });
    }

    container.querySelector('#btn-export-not-submitted')?.addEventListener('click', () => {
      const rows = (notSubmitted || []).map(s => {
        const nameParts = splitName(s.full_name || `${s.given_name || ''} ${s.family_name || ''}`.trim());
        const firstName = s.given_name || nameParts.given || '';
        const lastName = s.family_name || nameParts.family || '';
        const fullName = s.full_name || joinName({ given: firstName, family: lastName });
        const baseTakeUrl = `${window.location.origin}${window.location.pathname}#/assessments/take`;
        const link = LinkBuilder.withParams(baseTakeUrl, { sid: s.student_id, sname: fullName });
        return {
          Email: s.email || '',
          FirstName: firstName,
          LastName: lastName,
          FullName: fullName,
          StudentID: s.student_id,
          Assignment: a.title || 'Assignment',
          DueDate: a.settings?.due_date || '',
          Link: link
        };
      });
      const cols = ['Email', 'FirstName', 'LastName', 'FullName', 'StudentID', 'Assignment', 'DueDate', 'Link'];
      const text = toCSV(rows, cols);
      downloadCSV(`${(a.title || 'assignment').replace(/[^a-z0-9_-]+/gi, '_')}_not_submitted.csv`, text);
      toast.success(`Exported ${rows.length} not-submitted students.`);
    });

    container.querySelector('#sub-pull-relay')?.addEventListener('click', async () => {
      const btn = container.querySelector('#sub-pull-relay');
      if (btn) btn.loading = true;
      try {
        const { getTransport } = await import('../../core/transport.js');
        const transport = await getTransport();
        if (!transport || !transport.baseUrl || !transport.token) {
          throw new Error('Not connected to a school server. Check Settings > Connect to a school server.');
        }
        const dropId = a.publish?.relay?.drop_id;
        if (!dropId) throw new Error('No drop ID found on this assessment.');

        const res = await transport.listDrop(dropId, { since: a.publish?.relay?.last_pulled_at });
        const items = res?.items || [];
        const texts = [];
        for (const item of items) {
          const raw = typeof item === 'string' ? item : (item.text || item.payload || '');
          if (raw) texts.push({ text: raw, source: 'Server Dropbox' });
        }
        if (a.publish?.relay) {
          a.publish.relay.last_pulled_at = new Date().toISOString();
          await storage.table('assignments').put(a);
        }
        if (texts.length) {
          await importTexts(texts);
        } else {
          toast.info('No new submissions found on the server.');
        }
      } catch (err) {
        console.error(err);
        toast.danger('Failed to pull from server: ' + (err.message || String(err)));
      } finally {
        if (btn) btn.loading = false;
      }
    });

    container.querySelector('#sub-scan-qr')?.addEventListener('click', async () => {
      const { openQrScanner } = await import('../../components/qr-handoff.js');
      openQrScanner({
        label: `Scan Student Submissions · ${a.title || 'Assignment'}`,
        readyText: 'Point camera at student\'s submission QR code...',
        continuous: true,
        onSubmission: async (text) => {
          await importTexts([{ text, source: 'Camera Scan' }]);
        }
      });
    });

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
