import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { SubmissionCrypto, sha256Hex } from '../../core/submission-crypto.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { buildStudentPayload, checkAnswerLocally, gradeSubmission, INSTANT_CHECK_TYPES, BLANK_TOKEN } from './grading.js';
import { createSubmission, checkAccessCode } from './pipeline.js';
import { QUESTION_TYPE_META } from './question-types.js';

/**
 * Student Take Mode (KB-ASSIGN-005)
 * Start → one question per screen → submit → encrypted hand-in (.kbsub file or code).
 * `?preview=<id>` lets the teacher try the assignment locally without producing a submission.
 */

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));
const PAYLOAD_SESSION_KEY = 'kb_asg_active_payload';

const safeStorage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} },
  remove(key) { try { localStorage.removeItem(key); } catch (_) {} }
};

async function resolvePayload(params) {
  if (params.preview) {
    const a = await storage.table('assignments').get(params.preview);
    if (!a) return null;
    const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
    const payload = await buildStudentPayload(
      { ...a, publish: { version: a.publish?.version || 0, salt: a.publish?.salt || 'preview-salt' } },
      { teacherKeys: keys }
    );
    return { payload, preview: true, teacherAssignment: a };
  }
  const eph = store.getState('ephemeralData');
  if (eph && eph.type === 'assignment' && eph.payload?.kind === 'kb-assignment') {
    try { sessionStorage.setItem(PAYLOAD_SESSION_KEY, JSON.stringify(eph.payload)); } catch (_) {}
    return { payload: eph.payload, preview: false };
  }
  try {
    const cached = JSON.parse(sessionStorage.getItem(PAYLOAD_SESSION_KEY));
    if (cached?.kind === 'kb-assignment') return { payload: cached, preview: false };
  } catch (_) {}
  return null;
}

export async function renderTakeView(params, router, container) {
  const resolved = await resolvePayload(params);
  if (!resolved) {
    container.innerHTML = `
      <div class="max-w-xl mx-auto mt-6 p-8 text-center bg-white rounded-2xl border border-slate-200 shadow-xs space-y-4">
        <span class="w-12 h-12 mx-auto rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center text-2xl"><sl-icon name="link-45deg"></sl-icon></span>
        <h1 class="text-xl font-bold text-slate-900">Open your assignment link</h1>
        <p class="text-sm text-slate-500">Use the link or <code>.kbshare</code> file your teacher shared. Assignments open right here in your browser — nothing is uploaded.</p>
        <sl-button variant="primary" href="#/">Go home</sl-button>
      </div>`;
    return;
  }

  const { payload, preview, teacherAssignment } = resolved;
  const questions = payload.questions || [];
  const feedback = payload.settings?.feedback_mode || 'after_submit';
  const state = {
    screen: 'start',
    index: 0,
    student: { name: '', id: '', code: '' },
    answers: {},
    checked: {}, // qid → true/false/null after "Check answer" (instant feedback mode)
    startedAt: null,
    result: null
  };
  const draftKey = () => `kb_asg_draft_${payload.assignment_id}_${payload.publish_version}_${String(state.student.id).toUpperCase()}`;
  const receiptKey = () => `kb_asg_receipt_${payload.assignment_id}_${payload.publish_version}_${String(state.student.id).toUpperCase()}`;
  const saveDraft = () => {
    if (preview) return;
    safeStorage.set(draftKey(), { answers: state.answers, checked: state.checked, startedAt: state.startedAt, index: state.index, name: state.student.name });
  };

  const isAnswered = (q) => {
    const v = state.answers[q.id];
    if (v === undefined || v === null || v === '') return false;
    if (Array.isArray(v)) return q.type === 'fill_blank' ? v.some(x => String(x || '').trim()) : v.length > 0;
    if (typeof v === 'object') return Object.values(v).some(Boolean);
    return true;
  };

  const render = () => {
    if (state.screen === 'start') renderStart();
    else if (state.screen === 'question') renderQuestion();
    else renderResults();
  };

  // ---------------------------------------------------------------------------
  // Start screen
  // ---------------------------------------------------------------------------
  function renderStart() {
    const totalPts = questions.reduce((s, q) => s + (q.points || 0), 0);
    const needsCode = !!payload.settings?.require_access_code && !!payload.roster_checks;
    container.innerHTML = `
      <div class="max-w-xl mx-auto space-y-6">
        ${preview ? previewBanner() : ''}
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 space-y-6">
          <div class="space-y-3 text-center">
            <span class="w-14 h-14 mx-auto rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center text-2xl"><sl-icon name="ui-checks"></sl-icon></span>
            <h1 class="text-2xl font-bold text-slate-900">${esc(payload.title)}</h1>
            <div class="flex flex-wrap justify-center gap-2 text-xs">
              <span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">${questions.length} questions</span>
              <span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">${totalPts} points</span>
              ${payload.due_date ? `<span class="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">Due ${esc(new Date(`${payload.due_date}T12:00:00`).toLocaleDateString())}</span>` : ''}
              <span class="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">${feedback === 'immediate' ? 'Instant feedback' : feedback === 'after_submit' ? 'Score after submitting' : 'Graded by your teacher'}</span>
            </div>
          </div>
          ${payload.instructions ? `<div class="kb-prose text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl p-4">${Sanitizer.renderSTEMMarkdown(payload.instructions)}</div>` : ''}
          <form id="take-start-form" class="space-y-4" novalidate>
            <sl-input id="take-name" label="Your full name" required autocomplete="name" value="${esc(state.student.name)}"></sl-input>
            <sl-input id="take-id" label="Student ID" required autocomplete="off" value="${esc(state.student.id)}"></sl-input>
            <sl-input id="take-code" label="Access code${needsCode ? '' : ' (if your teacher gave you one)'}" ${needsCode ? 'required' : ''} autocomplete="off" placeholder="e.g. K7M2-QX9P" value="${esc(state.student.code)}">
              <sl-icon slot="prefix" name="key"></sl-icon>
            </sl-input>
            <div id="take-start-error" class="hidden text-sm text-red-600 flex items-start gap-2" role="alert"></div>
            <sl-button type="submit" variant="primary" size="large" class="w-full" id="take-begin">
              <sl-icon slot="prefix" name="play-fill"></sl-icon> Start
            </sl-button>
          </form>
          <p class="text-xs text-slate-400 text-center">Your answers stay in this browser until you hand in your encrypted submission. Only your teacher can open it (key <span class="font-mono">${esc(payload.teacher_key?.fingerprint)}</span>).</p>
        </div>
      </div>`;

    const form = container.querySelector('#take-start-form');
    const errorEl = container.querySelector('#take-start-error');
    const showError = (msg, allowContinue = false) => {
      errorEl.innerHTML = `<sl-icon name="exclamation-circle" class="mt-0.5 flex-shrink-0"></sl-icon><span>${msg}${allowContinue ? ' <button type="button" id="take-continue-anyway" class="underline font-medium">Continue anyway</button>' : ''}</span>`;
      errorEl.classList.remove('hidden');
      container.querySelector('#take-continue-anyway')?.addEventListener('click', begin);
    };

    async function begin() {
      // Restore a draft for this student if one exists
      const draft = preview ? null : safeStorage.get(draftKey());
      if (draft) {
        state.answers = draft.answers || {};
        state.checked = draft.checked || {};
        state.startedAt = draft.startedAt || new Date().toISOString();
        state.index = Math.min(draft.index || 0, questions.length - 1);
        toast.info('Restored your saved answers.');
      } else {
        state.startedAt = new Date().toISOString();
      }
      const existingReceipt = preview ? null : safeStorage.get(receiptKey());
      if (existingReceipt) {
        state.result = existingReceipt;
        state.screen = 'results';
      } else {
        state.screen = 'question';
      }
      render();
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      state.student.name = container.querySelector('#take-name').value.trim();
      state.student.id = container.querySelector('#take-id').value.trim();
      state.student.code = container.querySelector('#take-code').value.trim();
      errorEl.classList.add('hidden');
      if (!state.student.name || !state.student.id) return showError('Enter your name and student ID.');
      if (needsCode && !state.student.code) return showError('Enter the access code your teacher gave you.');
      if (state.student.code) {
        const status = await checkAccessCode(payload, state.student.id, state.student.code);
        if (status === 'mismatch') return showError('That access code doesn\'t match this student ID. Check both for typos.');
        if (status === 'unknown_student') return showError('This student ID isn\'t on the class list. Check it with your teacher.', true);
      }
      begin();
    });
  }

  const previewBanner = () => `
    <div class="flex items-center justify-between gap-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">
      <span class="flex items-center gap-2"><sl-icon name="eye"></sl-icon> Preview — this is what students see. Nothing is submitted.</span>
      <sl-button size="small" id="take-exit-preview">Back to editor</sl-button>
    </div>`;

  // ---------------------------------------------------------------------------
  // Question screen
  // ---------------------------------------------------------------------------
  function inputFor(q) {
    const v = state.answers[q.id];
    const locked = state.checked[q.id] !== undefined;
    const dis = locked ? 'disabled' : '';
    switch (q.type) {
      case 'single_choice':
      case 'multi_choice': {
        const multi = q.type === 'multi_choice';
        const selected = new Set(multi ? (v || []) : [v]);
        return `
          ${multi ? '<p class="text-xs font-medium text-slate-500">Select all that apply.</p>' : ''}
          <div class="space-y-2" role="${multi ? 'group' : 'radiogroup'}" aria-label="Answer options">
            ${(q.options || []).map((o, i) => {
              const on = selected.has(o.id);
              return `
                <button type="button" data-choice="${esc(o.id)}" role="${multi ? 'checkbox' : 'radio'}" aria-checked="${on}" ${dis}
                  class="w-full flex items-center gap-3 text-left p-3.5 rounded-xl border transition-colors ${on ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'} disabled:cursor-not-allowed">
                  <span class="w-7 h-7 flex-shrink-0 rounded-${multi ? 'md' : 'full'} border flex items-center justify-center text-xs font-semibold ${on ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300 text-slate-500'}">${on ? '<sl-icon name="check-lg"></sl-icon>' : String.fromCharCode(65 + i)}</span>
                  <span class="kb-prose text-slate-800 [&_p]:m-0">${Sanitizer.renderSTEMMarkdown(o.text)}</span>
                </button>`;
            }).join('')}
          </div>`;
      }
      case 'true_false':
        return `
          <div class="grid grid-cols-2 gap-3" role="radiogroup" aria-label="True or false">
            ${['true', 'false'].map(t => {
              const on = v === (t === 'true');
              return `<button type="button" data-tf="${t}" role="radio" aria-checked="${on}" ${dis}
                class="p-4 rounded-xl border text-base font-semibold transition-colors ${on ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-500' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}">
                <sl-icon name="${t === 'true' ? 'check-circle' : 'x-circle'}" class="mr-1.5 align-[-2px]"></sl-icon>${t === 'true' ? 'True' : 'False'}</button>`;
            }).join('')}
          </div>`;
      case 'short_text':
        return `<sl-input id="take-text" size="large" placeholder="Type your answer" value="${esc(v || '')}" ${dis}></sl-input>`;
      case 'numeric':
        return `<sl-input id="take-text" size="large" inputmode="decimal" placeholder="Enter a number" value="${esc(v || '')}" ${dis}>${q.unit ? `<span slot="suffix" class="text-slate-500">${esc(q.unit)}</span>` : ''}</sl-input>
          <p class="text-xs text-slate-500">You can write 6.02e23 or 6.02 × 10^23.</p>`;
      case 'long_text':
        return `<sl-textarea id="take-text" rows="7" resize="auto" placeholder="Write your response" value="${esc(v || '')}" ${dis}></sl-textarea>
          <p class="text-xs text-slate-500 text-right" id="take-wordcount"></p>`;
      case 'ordering': {
        const ids = Array.isArray(v) && v.length ? v : q.items.map(i => i.id);
        if (!Array.isArray(v)) state.answers[q.id] = ids;
        const byId = new Map(q.items.map(i => [i.id, i]));
        return `
          <p class="text-xs font-medium text-slate-500">Drag items, or use the arrows, to put them in order.</p>
          <ol class="space-y-2" id="take-order-list">
            ${ids.map((id, i) => `
              <li draggable="${!locked}" data-order-id="${esc(id)}" class="flex items-center gap-3 p-3 rounded-xl border border-slate-200 bg-white ${locked ? '' : 'cursor-grab active:cursor-grabbing'}">
                <sl-icon name="grip-vertical" class="text-slate-400 flex-shrink-0" aria-hidden="true"></sl-icon>
                <span class="w-6 h-6 flex-shrink-0 rounded-md bg-slate-100 text-slate-600 text-xs font-semibold flex items-center justify-center tabular-nums">${i + 1}</span>
                <span class="flex-1 kb-prose text-slate-800 [&_p]:m-0">${Sanitizer.renderSTEMMarkdown(byId.get(id)?.text || '')}</span>
                <button type="button" class="kb-icon-btn" data-order-move="${i}:-1" aria-label="Move up" ${i === 0 || locked ? 'disabled' : ''}><sl-icon name="arrow-up"></sl-icon></button>
                <button type="button" class="kb-icon-btn" data-order-move="${i}:1" aria-label="Move down" ${i === ids.length - 1 || locked ? 'disabled' : ''}><sl-icon name="arrow-down"></sl-icon></button>
              </li>`).join('')}
          </ol>`;
      }
      case 'matching': {
        const map = v || {};
        return `
          <div class="space-y-3">
            ${(q.lefts || []).map(l => `
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4 items-center p-3 rounded-xl border border-slate-200 bg-white">
                <div class="kb-prose text-slate-800 font-medium [&_p]:m-0">${Sanitizer.renderSTEMMarkdown(l.text)}</div>
                <sl-select data-match="${esc(l.id)}" placeholder="Choose a match" value="${esc(map[l.id] ? encodeURIComponent(map[l.id]) : '')}" ${dis} hoist>
                  ${(q.rights || []).map(r => `<sl-option value="${esc(encodeURIComponent(r))}">${esc(r)}</sl-option>`).join('')}
                </sl-select>
              </div>`).join('')}
          </div>`;
      }
      default:
        return '';
    }
  }

  function promptHtml(q) {
    if (q.type !== 'fill_blank') return Sanitizer.renderSTEMMarkdown(q.prompt);
    // Inline inputs replace each [[blank]]
    let i = 0;
    const tokenized = String(q.prompt || '').replace(BLANK_TOKEN, () => `@@KBBLANK${i++}@@`);
    const html = Sanitizer.renderSTEMMarkdown(tokenized);
    const values = Array.isArray(state.answers[q.id]) ? state.answers[q.id] : [];
    const locked = state.checked[q.id] !== undefined;
    return html.replace(/@@KBBLANK(\d+)@@/g, (_, n) => `<input type="text" data-blank="${n}" aria-label="Blank ${Number(n) + 1}" value="${esc(values[n] || '')}" ${locked ? 'disabled' : ''}
      class="inline-block mx-1 my-0.5 w-32 px-2 py-1 rounded-md border border-slate-300 bg-white text-slate-900 text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none disabled:bg-slate-100">`);
  }

  function feedbackBlock(q) {
    if (feedback !== 'immediate') return '';
    const res = state.checked[q.id];
    if (res === undefined) {
      if (!INSTANT_CHECK_TYPES.has(q.type)) {
        return `<p class="text-sm text-slate-500 flex items-center gap-2"><sl-icon name="person-check"></sl-icon> Your teacher will check this answer.</p>`;
      }
      return '';
    }
    const reveal = payload.reveal?.[q.id];
    const toneClass = res === true
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : res === false ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-slate-200 bg-slate-50 text-slate-700';
    const label = res === true ? 'Correct!' : res === false ? 'Not quite.' : 'Saved — your teacher will check this.';
    return `
      <div class="p-4 rounded-xl border ${toneClass} space-y-1" role="status">
        <div class="font-semibold flex items-center gap-2"><sl-icon name="${res === true ? 'check-circle-fill' : res === false ? 'x-circle-fill' : 'hourglass-split'}"></sl-icon>${label}</div>
        ${res === false && q.type === 'short_text' ? '<div class="text-sm">Small spelling slips may still earn credit when your teacher reviews it.</div>' : ''}
        ${reveal && res !== true ? `<div class="text-sm">Correct answer: <strong>${esc(reveal.answer)}</strong></div>` : ''}
        ${reveal?.explanation ? `<div class="text-sm kb-prose [&_p]:m-0">${Sanitizer.renderSTEMMarkdown(reveal.explanation)}</div>` : ''}
      </div>`;
  }

  function renderQuestion() {
    const q = questions[state.index];
    const answeredCount = questions.filter(isAnswered).length;
    const meta = QUESTION_TYPE_META[q.type] || {};
    const canCheck = feedback === 'immediate' && INSTANT_CHECK_TYPES.has(q.type) && state.checked[q.id] === undefined;
    const isLast = state.index === questions.length - 1;

    container.innerHTML = `
      <div class="max-w-3xl mx-auto space-y-5">
        ${preview ? previewBanner() : ''}
        <div class="bg-white rounded-2xl border border-slate-200 shadow-xs p-4 sm:p-5 space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <h1 class="font-bold text-slate-900 truncate">${esc(payload.title)}</h1>
              <p class="text-xs text-slate-500 truncate">${esc(state.student.name)} · ${esc(state.student.id)}</p>
            </div>
            <span class="text-xs text-slate-500 tabular-nums flex-shrink-0">${answeredCount} / ${questions.length} answered</span>
          </div>
          <sl-progress-bar value="${Math.round((answeredCount / Math.max(1, questions.length)) * 100)}" style="--height: 6px;" aria-label="Progress"></sl-progress-bar>
          <nav class="flex flex-wrap gap-1.5" aria-label="Questions">
            ${questions.map((qq, i) => {
              const c = state.checked[qq.id];
              let cls = isAnswered(qq) ? 'bg-slate-200 text-slate-800 border-slate-200' : 'bg-white text-slate-500 border-slate-200';
              if (c === true) cls = 'bg-emerald-100 text-emerald-800 border-emerald-200';
              if (c === false) cls = 'bg-rose-100 text-rose-800 border-rose-200';
              const cur = i === state.index ? 'ring-2 ring-blue-500' : '';
              return `<button type="button" data-goto="${i}" class="w-8 h-8 rounded-lg border text-xs font-semibold tabular-nums ${cls} ${cur}" aria-label="Question ${i + 1}${isAnswered(qq) ? ', answered' : ''}" ${i === state.index ? 'aria-current="step"' : ''}>${i + 1}</button>`;
            }).join('')}
          </nav>
        </div>

        <section class="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-7 space-y-5" aria-labelledby="take-q-title">
          <div class="flex items-center justify-between gap-3 text-xs text-slate-500">
            <span id="take-q-title" class="font-semibold uppercase tracking-wider">Question ${state.index + 1} of ${questions.length}</span>
            <span class="flex items-center gap-1.5"><sl-icon name="${meta.icon || 'question'}"></sl-icon>${esc(meta.label || '')} · ${q.points} pt${q.points === 1 ? '' : 's'}</span>
          </div>
          <div class="kb-prose text-lg text-slate-900 leading-relaxed">${promptHtml(q)}</div>
          <div class="space-y-3" id="take-input">${inputFor(q)}</div>
          <div id="take-feedback">${feedbackBlock(q)}</div>
        </section>

        <div class="flex items-center justify-between gap-2">
          <sl-button id="take-prev" ${state.index === 0 ? 'disabled' : ''} aria-label="Previous question"><sl-icon slot="prefix" name="arrow-left"></sl-icon><span class="hidden sm:inline">Previous</span></sl-button>
          <div class="flex items-center gap-2">
            ${canCheck ? '<sl-button id="take-check" variant="default"><sl-icon slot="prefix" name="check2-circle"></sl-icon> Check<span class="hidden sm:inline">&nbsp;answer</span></sl-button>' : ''}
            ${isLast
              ? `<sl-button id="take-submit" variant="primary"><sl-icon slot="prefix" name="send"></sl-icon> ${preview ? 'Finish preview' : 'Review & submit'}</sl-button>`
              : '<sl-button id="take-next" variant="primary">Next <sl-icon slot="suffix" name="arrow-right"></sl-icon></sl-button>'}
          </div>
        </div>
        ${!isLast ? `<div class="text-center"><button type="button" id="take-submit-early" class="text-sm text-slate-500 hover:text-slate-800 underline underline-offset-2">${preview ? 'Finish preview' : 'Submit now'}</button></div>` : ''}
      </div>`;

    bindQuestion(q);
  }

  const refreshNavOnly = () => {
    // Update answered counters without re-rendering (keeps focus in text inputs)
    const answeredCount = questions.filter(isAnswered).length;
    container.querySelector('sl-progress-bar')?.setAttribute('value', String(Math.round((answeredCount / Math.max(1, questions.length)) * 100)));
    const counter = container.querySelector('.tabular-nums.flex-shrink-0');
    if (counter) counter.textContent = `${answeredCount} / ${questions.length} answered`;
    container.querySelectorAll('[data-goto]').forEach(btn => {
      const qq = questions[Number(btn.dataset.goto)];
      if (state.checked[qq.id] !== undefined) return;
      btn.classList.toggle('bg-slate-200', isAnswered(qq));
      btn.classList.toggle('text-slate-800', isAnswered(qq));
      btn.classList.toggle('bg-white', !isAnswered(qq));
    });
  };

  function bindQuestion(q) {
    const root = container;
    const setAnswer = (val, rerender = false) => {
      state.answers[q.id] = val;
      saveDraft();
      if (rerender) renderQuestion();
      else refreshNavOnly();
    };

    root.querySelector('#take-exit-preview')?.addEventListener('click', () => router.navigate(`#/assignments/edit?id=${payload.assignment_id}`));

    root.querySelectorAll('[data-choice]').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.dataset.choice;
      if (q.type === 'multi_choice') {
        const set = new Set(state.answers[q.id] || []);
        if (set.has(id)) set.delete(id); else set.add(id);
        setAnswer([...set], true);
      } else {
        setAnswer(id, true);
      }
    }));
    root.querySelectorAll('[data-tf]').forEach(btn => btn.addEventListener('click', () => setAnswer(btn.dataset.tf === 'true', true)));

    const text = root.querySelector('#take-text');
    if (text) {
      const wc = root.querySelector('#take-wordcount');
      const updateWc = () => {
        if (!wc) return;
        const words = String(text.value || '').trim().split(/\s+/).filter(Boolean).length;
        wc.textContent = `${words} word${words === 1 ? '' : 's'}`;
      };
      updateWc();
      text.addEventListener('sl-input', () => { setAnswer(text.value); updateWc(); });
      setTimeout(() => text.focus?.(), 50);
    }

    root.querySelectorAll('input[data-blank]').forEach(inp => inp.addEventListener('input', () => {
      const arr = Array.isArray(state.answers[q.id]) ? [...state.answers[q.id]] : [];
      arr[Number(inp.dataset.blank)] = inp.value;
      setAnswer(arr);
    }));

    root.querySelectorAll('[data-match]').forEach(sel => sel.addEventListener('sl-change', () => {
      const map = { ...(state.answers[q.id] || {}) };
      map[sel.dataset.match] = sel.value ? decodeURIComponent(sel.value) : '';
      setAnswer(map);
    }));

    // Ordering: buttons + drag and drop
    root.querySelectorAll('[data-order-move]').forEach(btn => btn.addEventListener('click', () => {
      const [i, d] = btn.dataset.orderMove.split(':').map(Number);
      const arr = [...state.answers[q.id]];
      const j = i + d;
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      setAnswer(arr, true);
      root.querySelector(`[data-order-move="${j}:${d}"]`)?.focus();
    }));
    const list = root.querySelector('#take-order-list');
    if (list) {
      let dragId = null;
      list.addEventListener('dragstart', (e) => {
        const li = e.target.closest('[data-order-id]');
        dragId = li?.dataset.orderId;
        e.dataTransfer.effectAllowed = 'move';
        li?.classList.add('opacity-50');
      });
      list.addEventListener('dragover', (e) => e.preventDefault());
      list.addEventListener('drop', (e) => {
        e.preventDefault();
        const target = e.target.closest('[data-order-id]');
        if (!dragId || !target || target.dataset.orderId === dragId) return;
        const arr = state.answers[q.id].filter(id => id !== dragId);
        arr.splice(arr.indexOf(target.dataset.orderId) + (e.offsetY > target.offsetHeight / 2 ? 1 : 0), 0, dragId);
        setAnswer(arr, true);
      });
      list.addEventListener('dragend', () => { dragId = null; renderQuestion(); });
    }

    root.querySelectorAll('[data-goto]').forEach(btn => btn.addEventListener('click', () => {
      state.index = Number(btn.dataset.goto);
      saveDraft();
      renderQuestion();
    }));
    root.querySelector('#take-prev')?.addEventListener('click', () => { state.index--; saveDraft(); renderQuestion(); });
    root.querySelector('#take-next')?.addEventListener('click', () => { state.index++; saveDraft(); renderQuestion(); });
    root.querySelector('#take-check')?.addEventListener('click', async () => {
      if (!isAnswered(q)) {
        toast.warning('Answer the question first.');
        return;
      }
      state.checked[q.id] = await checkAnswerLocally(q, state.answers[q.id], payload.salt);
      saveDraft();
      renderQuestion();
    });
    const submit = () => confirmSubmit();
    root.querySelector('#take-submit')?.addEventListener('click', submit);
    root.querySelector('#take-submit-early')?.addEventListener('click', submit);
  }

  // ---------------------------------------------------------------------------
  // Submit & results
  // ---------------------------------------------------------------------------
  async function confirmSubmit() {
    const unanswered = questions.map((q, i) => ({ q, i })).filter(x => !isAnswered(x.q));
    if (!preview) {
      const message = unanswered.length
        ? `You have ${unanswered.length} unanswered question${unanswered.length === 1 ? '' : 's'} (${unanswered.map(x => `#${x.i + 1}`).join(', ')}). Submit anyway? You can't change answers afterwards.`
        : 'Submit your answers? You can\'t change them afterwards.';
      const ok = await ConfirmDialog.show({ title: 'Submit assignment', message, confirmText: 'Submit', variant: 'primary' });
      if (!ok) return;
    }

    // Local estimate (all-or-nothing on checkable questions; the teacher's re-grade is authoritative)
    const perQuestion = {};
    let earned = 0;
    let checkable = 0;
    for (const q of questions) {
      const r = state.checked[q.id] !== undefined ? state.checked[q.id] : await checkAnswerLocally(q, state.answers[q.id], payload.salt);
      perQuestion[q.id] = r;
      if (r !== null && r !== undefined) {
        checkable += q.points || 0;
        if (r === true) earned += q.points || 0;
      }
    }
    const clientScore = { earned, checkable, possible: questions.reduce((s, q) => s + (q.points || 0), 0) };

    let submission = null;
    if (!preview) {
      try {
        submission = await createSubmission({
          payload,
          studentId: state.student.id,
          studentName: state.student.name,
          accessCode: state.student.code,
          answers: state.answers,
          startedAt: state.startedAt,
          clientScore
        });
      } catch (err) {
        console.error('Submission encryption failed:', err);
        toast.danger('Could not create your submission. Your answers are still saved — try again.');
        return;
      }
    }

    state.result = {
      perQuestion,
      clientScore,
      submittedAt: new Date().toISOString(),
      text: submission?.text || null,
      receiptId: submission ? (await sha256Hex(submission.text)).slice(0, 8).toUpperCase() : null,
      answers: state.answers,
      teacherGrade: preview && teacherAssignment ? gradeSubmission(teacherAssignment, state.answers) : null
    };
    if (!preview) {
      safeStorage.set(receiptKey(), state.result);
      safeStorage.remove(draftKey());
    }
    state.screen = 'results';
    render();
  }

  function answerText(q, v) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '<span class="text-slate-400">No answer</span>';
    switch (q.type) {
      case 'single_choice': return esc(q.options?.find(o => o.id === v)?.text || '');
      case 'multi_choice': return esc((q.options || []).filter(o => v.includes(o.id)).map(o => o.text).join('; '));
      case 'true_false': return v ? 'True' : 'False';
      case 'fill_blank': return esc(v.map((x, i) => `${i + 1}. ${x || '—'}`).join('  '));
      case 'ordering': return esc(v.map(id => q.items?.find(i => i.id === id)?.text || '').join(' → '));
      case 'matching': return esc((q.lefts || []).map(l => `${l.text} → ${v[l.id] || '—'}`).join('; '));
      default: return esc(String(v)).slice(0, 400);
    }
  }

  function renderResults() {
    const r = state.result;
    const showScore = feedback !== 'none';
    const pct = r.clientScore.checkable ? Math.round((r.clientScore.earned / r.clientScore.checkable) * 100) : null;
    container.innerHTML = `
      <div class="max-w-3xl mx-auto space-y-6">
        ${preview ? previewBanner() : ''}
        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8 text-center space-y-3">
          <span class="w-14 h-14 mx-auto rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center text-3xl"><sl-icon name="check2-circle"></sl-icon></span>
          <h1 class="text-2xl font-bold text-slate-900">${preview ? 'Preview finished' : 'Answers locked in'}</h1>
          ${showScore ? `
            <p class="text-slate-600">Auto-checked score: <strong class="text-slate-900 text-lg tabular-nums">${r.clientScore.earned} / ${r.clientScore.checkable}</strong>${pct !== null ? ` <span class="text-slate-400">(${pct}%)</span>` : ''}</p>
            <p class="text-sm text-slate-500 max-w-md mx-auto">Your teacher's grade is final and may add partial credit${r.clientScore.checkable < r.clientScore.possible ? ` and points for answers they review (${r.clientScore.possible - r.clientScore.checkable} pts)` : ''}.</p>
          ` : '<p class="text-slate-600">Your teacher will share your grade after reviewing your work.</p>'}
          ${r.teacherGrade ? `<p class="text-sm text-amber-700">Teacher re-grade from the answer key: <strong>${r.teacherGrade.earned} / ${r.teacherGrade.possible}</strong>${r.teacherGrade.needs_manual ? ` (+ ${r.teacherGrade.needs_manual} for manual review)` : ''}</p>` : ''}
        </div>

        ${!preview ? `
          <section class="bg-amber-50 border-2 border-amber-300 rounded-2xl p-5 sm:p-6 space-y-4" aria-labelledby="handin-title">
            <div class="flex items-start gap-3">
              <span class="w-10 h-10 flex-shrink-0 rounded-xl bg-amber-500 text-white flex items-center justify-center text-xl"><sl-icon name="box-arrow-up"></sl-icon></span>
              <div>
                <h2 id="handin-title" class="font-bold text-amber-900 text-lg">Last step: hand in your submission</h2>
                <p class="text-sm text-amber-800">Your work is <strong>not sent automatically</strong>. Upload the file where your teacher asked (for example your LMS), or paste the code.</p>
              </div>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <sl-button variant="primary" size="large" id="res-download"><sl-icon slot="prefix" name="download"></sl-icon> Download submission file</sl-button>
              <sl-button size="large" id="res-copy"><sl-icon slot="prefix" name="clipboard"></sl-icon> Copy submission code</sl-button>
            </div>
            <p class="text-xs text-amber-800">Encrypted for your teacher's key <span class="font-mono font-semibold">${esc(payload.teacher_key?.fingerprint)}</span> · receipt <span class="font-mono">${esc(r.receiptId)}</span> · ${esc(new Date(r.submittedAt).toLocaleString())}. Classmates can't read or change it.</p>
          </section>` : ''}

        ${showScore ? `
          <section class="bg-white rounded-2xl border border-slate-200 shadow-xs p-5 sm:p-6 space-y-4">
            <h2 class="font-semibold text-slate-900">Your answers</h2>
            <ol class="space-y-3">
              ${questions.map((q, i) => {
                const c = r.perQuestion[q.id];
                const icon = c === true ? 'check-circle-fill text-emerald-600' : c === false ? 'x-circle-fill text-rose-600' : 'hourglass-split text-slate-400';
                const reveal = payload.reveal?.[q.id];
                return `
                  <li class="flex gap-3 p-3 rounded-xl border border-slate-200">
                    <sl-icon name="${icon.split(' ')[0]}" class="${icon.split(' ').slice(1).join(' ')} text-lg flex-shrink-0 mt-0.5"></sl-icon>
                    <div class="min-w-0 space-y-1 text-sm">
                      <div class="font-medium text-slate-900">${i + 1}. <span class="kb-prose [&_p]:inline [&_p]:m-0">${Sanitizer.renderSTEMMarkdown(String(q.prompt || '').replace(BLANK_TOKEN, '____'))}</span></div>
                      <div class="text-slate-600">Your answer: ${answerText(q, r.answers[q.id])}</div>
                      ${reveal && c !== true && reveal.answer ? `<div class="text-emerald-700">Correct answer: ${esc(reveal.answer)}</div>` : ''}
                      ${reveal?.explanation ? `<div class="text-slate-500 kb-prose [&_p]:m-0">${Sanitizer.renderSTEMMarkdown(reveal.explanation)}</div>` : ''}
                      ${c === null ? '<div class="text-slate-400">Checked by your teacher</div>' : ''}
                    </div>
                  </li>`;
              }).join('')}
            </ol>
          </section>` : ''}

        ${preview ? '<div class="flex justify-center"><sl-button id="res-restart"><sl-icon slot="prefix" name="arrow-counterclockwise"></sl-icon> Try again</sl-button></div>' : ''}
      </div>`;

    container.querySelector('#take-exit-preview')?.addEventListener('click', () => router.navigate(`#/assignments/edit?id=${payload.assignment_id}`));
    container.querySelector('#res-restart')?.addEventListener('click', () => {
      state.answers = {};
      state.checked = {};
      state.index = 0;
      state.screen = 'question';
      render();
    });
    container.querySelector('#res-download')?.addEventListener('click', () => {
      const name = `${payload.title}_${state.student.id}`.replace(/[^a-z0-9_-]+/gi, '_');
      const blob = new Blob([r.text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name}.kbsub`;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 100);
      toast.success('Submission file downloaded. Now hand it in.');
    });
    container.querySelector('#res-copy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(r.text);
        toast.success('Submission code copied. Paste it where your teacher asked.');
      } catch (_) {
        toast.warning('Copy failed — use the download button instead.');
      }
    });
  }

  render();
}
