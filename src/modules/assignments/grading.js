import { SubmissionCrypto } from '../../core/submission-crypto.js';

/**
 * Assignments Auto-Grading Engine (KB-ASSIGN-001)
 *
 * Pure functions (no DOM, no storage) used in three places:
 *  - the teacher's device, which grades every submission from the true answer key;
 *  - the publish step, which strips the key and replaces it with salted hashes;
 *  - the student's page, which uses those hashes for instant feedback when allowed.
 *
 * Question types: single_choice, multi_choice, true_false, short_text, numeric,
 * fill_blank, ordering, matching, long_text (manual only).
 */

export const QUESTION_TYPES = [
  'single_choice', 'multi_choice', 'true_false', 'short_text', 'numeric',
  'fill_blank', 'ordering', 'matching', 'long_text'
];

/** Types whose correctness a student's browser can check from published hashes */
export const INSTANT_CHECK_TYPES = new Set(['single_choice', 'multi_choice', 'true_false', 'short_text', 'fill_blank', 'ordering', 'matching']);

export const BLANK_TOKEN = /\[\[blank\]\]/gi;

// -----------------------------------------------------------------------------
// Normalizers
// -----------------------------------------------------------------------------

/**
 * Normalize free text for comparison: Unicode NFKC, straight quotes, collapsed whitespace,
 * trailing punctuation removed, lower-cased unless case-sensitive.
 */
export function normalizeText(value, { caseSensitive = false } = {}) {
  let s = String(value ?? '').normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:]+$/, '')
    .trim();
  if (!caseSensitive) s = s.toLowerCase();
  return s;
}

/**
 * Parse a numeric answer. Accepts "3.5", "3,5", "-2", "6.02e23", "6.02 x 10^23", "6.02×10^23",
 * and ignores trailing units ("12.5 mL").
 * @returns {number|null}
 */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value ?? '').trim().replace(/−/g, '-').replace(/\s+/g, '');
  if (!s) return null;
  const sci = s.match(/^([-+]?\d*[.,]?\d+)(?:[x×*]10\^?([-+]?\d+))$/i);
  if (sci) {
    const mant = parseFloat(sci[1].replace(',', '.'));
    return mant * Math.pow(10, parseInt(sci[2], 10));
  }
  // Comma as decimal separator only when there is no dot ("3,5" → 3.5, "1,000.5" → 1000.5)
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const m = s.match(/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function countBlanks(prompt) {
  return (String(prompt || '').match(BLANK_TOKEN) || []).length;
}

const round2 = (n) => Math.round(n * 100) / 100;
const pts = (q) => Math.max(0, Number(q.points) || 0);

/** Does a free-text answer match one of the accepted answers? */
export function matchesAccepted(answer, accepted, { caseSensitive = false, allowTypo = false } = {}) {
  const a = normalizeText(answer, { caseSensitive });
  if (!a) return false;
  for (const acc of accepted || []) {
    const b = normalizeText(acc, { caseSensitive });
    if (!b) continue;
    if (a === b) return true;
    if (allowTypo && b.length >= 5 && levenshtein(a, b) <= 1) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Grading
// -----------------------------------------------------------------------------

function result(question, fraction, extra = {}) {
  const possible = pts(question);
  const f = Math.max(0, Math.min(1, fraction));
  return {
    earned: round2(possible * f),
    possible,
    correct: f === 1,
    needs_manual: false,
    detail: {},
    ...extra
  };
}

const isBlank = (answer) => answer === undefined || answer === null || answer === '' ||
  (Array.isArray(answer) && answer.length === 0) ||
  (typeof answer === 'object' && !Array.isArray(answer) && Object.keys(answer).length === 0);

/**
 * Grade one question against the true key.
 * @returns {{ earned: number, possible: number, correct: boolean|null, needs_manual: boolean, detail: object }}
 */
export function gradeQuestion(question, answer) {
  const possible = pts(question);
  if (question.type === 'long_text') {
    return { earned: 0, possible, correct: null, needs_manual: true, detail: { answered: !isBlank(answer) } };
  }
  if (isBlank(answer)) {
    return { earned: 0, possible, correct: false, needs_manual: false, detail: { unanswered: true } };
  }

  switch (question.type) {
    case 'single_choice': {
      const opt = (question.options || []).find(o => o.id === answer);
      return result(question, opt && opt.is_correct ? 1 : 0);
    }

    case 'multi_choice': {
      const picked = new Set(Array.isArray(answer) ? answer : [answer]);
      const correctIds = (question.options || []).filter(o => o.is_correct).map(o => o.id);
      const wrongPicks = [...picked].filter(id => !correctIds.includes(id)).length;
      const rightPicks = correctIds.filter(id => picked.has(id)).length;
      const exact = wrongPicks === 0 && rightPicks === correctIds.length;
      if (question.scoring !== 'partial') return result(question, exact ? 1 : 0, { detail: { rightPicks, wrongPicks } });
      const denom = Math.max(1, correctIds.length);
      const fraction = (rightPicks - wrongPicks) / denom;
      return result(question, exact ? 1 : fraction, { correct: exact, detail: { rightPicks, wrongPicks } });
    }

    case 'true_false': {
      const val = answer === true || answer === 'true';
      return result(question, val === !!question.correct ? 1 : 0);
    }

    case 'short_text': {
      const ok = matchesAccepted(answer, question.accepted, { caseSensitive: !!question.case_sensitive, allowTypo: !!question.allow_typo });
      return result(question, ok ? 1 : 0);
    }

    case 'numeric': {
      const n = parseNumber(answer);
      const target = Number(question.target);
      if (n === null || !Number.isFinite(target)) return result(question, 0, { detail: { parsed: n } });
      const tol = Math.abs(Number(question.tolerance) || 0);
      const allowed = question.tolerance_type === 'percent' ? Math.abs(target) * tol / 100 : tol;
      const ok = Math.abs(n - target) <= allowed + 1e-12;
      return result(question, ok ? 1 : 0, { detail: { parsed: n } });
    }

    case 'fill_blank': {
      const blanks = question.blanks || [];
      const answers = Array.isArray(answer) ? answer : [];
      const perBlank = blanks.map((b, i) => matchesAccepted(answers[i], b.accepted, { caseSensitive: !!question.case_sensitive, allowTypo: !!question.allow_typo }));
      const right = perBlank.filter(Boolean).length;
      const fraction = blanks.length ? right / blanks.length : 0;
      return result(question, question.scoring === 'all_or_nothing' ? (right === blanks.length ? 1 : 0) : fraction, { correct: blanks.length > 0 && right === blanks.length, detail: { perBlank } });
    }

    case 'ordering': {
      const items = question.items || [];
      const correctIndex = new Map(items.map((it, i) => [it.id, i]));
      const seq = (Array.isArray(answer) ? answer : []).filter(id => correctIndex.has(id));
      const exact = seq.length === items.length && seq.every((id, i) => correctIndex.get(id) === i);
      if (question.scoring === 'all_or_nothing' || items.length < 2) return result(question, exact ? 1 : 0);
      // Partial credit: share of adjacent pairs that are in the correct relative order
      let good = 0;
      for (let i = 0; i < seq.length - 1; i++) {
        if (correctIndex.get(seq[i]) < correctIndex.get(seq[i + 1])) good++;
      }
      const fraction = seq.length === items.length ? good / (items.length - 1) : 0;
      return result(question, exact ? 1 : fraction, { correct: exact, detail: { orderedPairs: good } });
    }

    case 'matching': {
      const pairs = question.pairs || [];
      const map = answer && typeof answer === 'object' ? answer : {};
      const perPair = pairs.map(p => normalizeText(map[p.id]) !== '' && normalizeText(map[p.id]) === normalizeText(p.right));
      const right = perPair.filter(Boolean).length;
      const fraction = pairs.length ? right / pairs.length : 0;
      return result(question, question.scoring === 'all_or_nothing' ? (right === pairs.length ? 1 : 0) : fraction, { correct: pairs.length > 0 && right === pairs.length, detail: { perPair } });
    }

    default:
      return { earned: 0, possible, correct: null, needs_manual: true, detail: { unknownType: question.type } };
  }
}

/**
 * Grade a whole submission.
 * @returns {{ earned: number, possible: number, per_question: Record<string, object>, needs_manual: number }}
 */
export function gradeSubmission(assignment, answers = {}) {
  const per = {};
  let earned = 0;
  let possible = 0;
  let manual = 0;
  for (const q of assignment.questions || []) {
    const r = gradeQuestion(q, answers[q.id]);
    per[q.id] = r;
    earned += r.earned;
    possible += r.possible;
    if (r.needs_manual) manual++;
  }
  return { earned: round2(earned), possible: round2(possible), per_question: per, needs_manual: manual };
}

/**
 * Final score combining auto-grading with teacher overrides (`manual[qid].points`).
 */
export function finalScore(assignment, submission) {
  let earned = 0;
  let possible = 0;
  let pending = 0;
  for (const q of assignment.questions || []) {
    const auto = submission.auto?.per_question?.[q.id] || gradeQuestion(q, submission.answers?.[q.id]);
    const override = submission.manual?.[q.id];
    possible += auto.possible;
    if (override && override.points !== null && override.points !== undefined && override.points !== '') {
      earned += Math.max(0, Math.min(auto.possible, Number(override.points) || 0));
    } else if (auto.needs_manual) {
      pending++;
    } else {
      earned += auto.earned;
    }
  }
  return { earned: round2(earned), possible: round2(possible), pending };
}

export function totalPoints(assignment) {
  return round2((assignment.questions || []).reduce((s, q) => s + pts(q), 0));
}

/**
 * Summarize overall and question-level feedback into a concise plain text block.
 * @param {object} assignment
 * @param {object} sub
 * @returns {string}
 */
export function feedbackSummary(assignment, sub) {
  const s = finalScore(assignment, sub);
  const lines = [];
  if (sub?.feedback && sub.feedback.trim()) lines.push(sub.feedback.trim());
  (assignment?.questions || []).forEach((q, i) => {
    const fb = sub?.manual?.[q.id]?.feedback;
    if (fb && fb.trim()) lines.push(`Q${i + 1}: ${fb.trim()}`);
  });
  lines.push(`Assignment: ${s.earned}/${s.possible} pts${s.pending ? ` (${s.pending} awaiting review)` : ''}.`);
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Student payload (answer key removed)
// -----------------------------------------------------------------------------

const hashKey = (salt, qid, part = '') => `${salt}|${qid}${part ? `|${part}` : ''}`;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Correct answers in a compact, student-displayable form (used for "show correct answers") */
export function describeCorrectAnswer(q) {
  switch (q.type) {
    case 'single_choice':
    case 'multi_choice':
      return (q.options || []).filter(o => o.is_correct).map(o => o.text).join('; ');
    case 'true_false':
      return q.correct ? 'True' : 'False';
    case 'short_text':
      return (q.accepted || []).join(' / ');
    case 'numeric': {
      const tol = Number(q.tolerance) || 0;
      const tolText = tol ? ` (± ${tol}${q.tolerance_type === 'percent' ? '%' : ''})` : '';
      return `${q.target}${q.unit ? ` ${q.unit}` : ''}${tolText}`;
    }
    case 'fill_blank':
      return (q.blanks || []).map((b, i) => `${i + 1}. ${(b.accepted || [])[0] || ''}`).join('  ');
    case 'ordering':
      return (q.items || []).map(it => it.text).join(' → ');
    case 'matching':
      return (q.pairs || []).map(p => `${p.left} → ${p.right}`).join('; ');
    default:
      return '';
  }
}

/**
 * Convert student answer value to readable text.
 * Used by review drawer, feedback payload, PDFs, and exports.
 */
export function answerToText(q, v) {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return 'No answer';
  switch (q.type) {
    case 'single_choice': return q.options?.find(o => o.id === v)?.text ?? '(removed option)';
    case 'multi_choice': return (q.options || []).filter(o => (Array.isArray(v) ? v : [v]).includes(o.id)).map(o => o.text).join('; ') || '—';
    case 'true_false': return v === true || v === 'true' ? 'True' : 'False';
    case 'fill_blank': return Array.isArray(v) ? v.map((x, i) => `${i + 1}. ${x || '—'}`).join('   ') : String(v);
    case 'ordering': return (Array.isArray(v) ? v : []).map(id => q.items?.find(i => i.id === id)?.text || '?').join(' → ');
    case 'matching': return (q.pairs || []).map(p => `${p.left} → ${v?.[p.id] || '—'}`).join('; ');
    case 'long_text': return String(v);
    default: return String(v);
  }
}

/**
 * Build the student-facing version of one question: no `is_correct`, no accepted answers,
 * shuffled where requested, plus salted hashes for instant feedback when enabled.
 */
export async function buildStudentQuestion(q, { salt, withChecks, shuffleOptions }) {
  const base = { id: q.id, type: q.type, prompt: q.prompt || '', points: pts(q) };
  const check = {};

  switch (q.type) {
    case 'single_choice':
    case 'multi_choice': {
      const opts = (q.options || []).map(o => ({ id: o.id, text: o.text }));
      base.options = shuffleOptions ? shuffle(opts) : opts;
      if (withChecks) {
        const correct = (q.options || []).filter(o => o.is_correct).map(o => o.id).sort().join(',');
        check.key = await SubmissionCrypto.hashAnswer(hashKey(salt, q.id), correct);
      }
      break;
    }
    case 'true_false':
      if (withChecks) check.key = await SubmissionCrypto.hashAnswer(hashKey(salt, q.id), q.correct ? 'true' : 'false');
      break;
    case 'short_text':
      if (withChecks) {
        check.keys = await Promise.all((q.accepted || []).map(a => SubmissionCrypto.hashAnswer(hashKey(salt, q.id), normalizeText(a, { caseSensitive: !!q.case_sensitive }))));
        check.case_sensitive = !!q.case_sensitive;
      }
      break;
    case 'numeric':
      if (q.unit) base.unit = q.unit;
      break;
    case 'fill_blank':
      base.blank_count = (q.blanks || []).length;
      if (withChecks) {
        check.blanks = await Promise.all((q.blanks || []).map((b, i) =>
          Promise.all((b.accepted || []).map(a => SubmissionCrypto.hashAnswer(hashKey(salt, q.id, `b${i}`), normalizeText(a, { caseSensitive: !!q.case_sensitive }))))));
        check.case_sensitive = !!q.case_sensitive;
      }
      break;
    case 'ordering': {
      const items = (q.items || []).map(it => ({ id: it.id, text: it.text }));
      // Always shuffle ordering items; the authored order is the answer
      let shuffled = shuffle(items);
      if (items.length > 1 && shuffled.every((it, i) => it.id === items[i].id)) shuffled = [...shuffled.slice(1), shuffled[0]];
      base.items = shuffled;
      if (withChecks) check.key = await SubmissionCrypto.hashAnswer(hashKey(salt, q.id), items.map(i => i.id).join(','));
      break;
    }
    case 'matching': {
      base.lefts = (q.pairs || []).map(p => ({ id: p.id, text: p.left }));
      const rights = [...new Set([...(q.pairs || []).map(p => p.right), ...(q.distractors || [])].filter(Boolean))];
      base.rights = shuffle(rights);
      if (withChecks) {
        check.pairs = {};
        for (const p of q.pairs || []) {
          check.pairs[p.id] = await SubmissionCrypto.hashAnswer(hashKey(salt, q.id, p.id), normalizeText(p.right));
        }
      }
      break;
    }
    case 'long_text':
    default:
      break;
  }

  if (withChecks && Object.keys(check).length) base.check = check;
  return base;
}

/**
 * Student-side instant check against published hashes.
 * @returns {Promise<boolean|null>} true/false, or null when the browser cannot judge it
 */
export async function checkAnswerLocally(studentQuestion, answer, salt) {
  const q = studentQuestion;
  const c = q.check;
  if (!c || !INSTANT_CHECK_TYPES.has(q.type)) return null;
  if (isBlank(answer)) return false;
  const h = (value, part) => SubmissionCrypto.hashAnswer(hashKey(salt, q.id, part), value);

  switch (q.type) {
    case 'single_choice':
      return (await h(String(answer))) === c.key;
    case 'multi_choice':
      return (await h([...(Array.isArray(answer) ? answer : [answer])].sort().join(','))) === c.key;
    case 'true_false':
      return (await h(answer === true || answer === 'true' ? 'true' : 'false')) === c.key;
    case 'short_text':
      // Typo tolerance can only be applied by the teacher's re-grade
      return (c.keys || []).includes(await h(normalizeText(answer, { caseSensitive: !!c.case_sensitive })));
    case 'fill_blank': {
      const answers = Array.isArray(answer) ? answer : [];
      for (let i = 0; i < (c.blanks || []).length; i++) {
        const hv = await h(normalizeText(answers[i], { caseSensitive: !!c.case_sensitive }), `b${i}`);
        if (!c.blanks[i].includes(hv)) return false;
      }
      return true;
    }
    case 'ordering':
      return (await h((answer || []).join(','))) === c.key;
    case 'matching': {
      for (const [pairId, hashed] of Object.entries(c.pairs || {})) {
        if ((await h(normalizeText(answer?.[pairId]), pairId)) !== hashed) return false;
      }
      return true;
    }
    default:
      return null;
  }
}

/**
 * Build the full student payload for publishing.
 * @param {object} assignment - teacher record (with keys)
 * @param {object} opts
 * @param {{ publicJwk: object, fingerprint: string }} opts.teacherKeys
 * @param {Record<string,string>|null} [opts.rosterChecks] - STUDENT_ID → access-code check value
 */
export async function buildStudentPayload(assignment, { teacherKeys, rosterChecks = null, rosterCards = null, courseMeta = null }) {
  const settings = assignment.settings || {};
  const salt = assignment.publish?.salt;
  if (!salt) throw new Error('MISSING_PUBLISH_SALT');
  const withChecks = settings.feedback_mode !== 'none';

  let questions = await Promise.all((assignment.questions || []).map(q =>
    buildStudentQuestion(q, { salt, withChecks, shuffleOptions: !!settings.shuffle_options })));
  if (settings.shuffle_questions) questions = shuffle(questions);

  const payload = {
    kind: 'kb-assignment',
    v: 1,
    assignment_id: assignment.id,
    publish_version: assignment.publish?.version || 1,
    course_id: assignment.gradebook?.course_id || assignment.class_id || null,
    mode: (assignment.gradebook?.course_id || assignment.class_id) ? 'graded' : 'practice',
    title: assignment.title || 'Assignment',
    instructions: assignment.instructions || '',
    due_date: settings.due_date || null,
    settings: {
      feedback_mode: settings.feedback_mode || 'after_submit',
      show_correct_answers: settings.feedback_mode === 'none' ? false : !!settings.show_correct_answers,
      require_access_code: !!settings.require_access_code,
      release_grade_immediately: settings.release_grade_immediately !== false
    },
    teacher_key: { publicJwk: teacherKeys.publicJwk, fingerprint: teacherKeys.fingerprint },
    roster_checks: rosterChecks && Object.keys(rosterChecks).length ? rosterChecks : null,
    salt,
    questions
  };

  if (rosterCards && typeof rosterCards === 'object' && Object.keys(rosterCards).length) {
    payload.roster_cards = rosterCards;
  }
  if (courseMeta && typeof courseMeta === 'object') {
    payload.course_meta = courseMeta;
  }

  if (settings.show_correct_answers && settings.feedback_mode !== 'none') {
    // Revealed after submission. This is display text, not a secret.
    payload.reveal = Object.fromEntries((assignment.questions || []).map(q => [q.id, {
      answer: describeCorrectAnswer(q),
      explanation: q.explanation || ''
    }]));
  }
  return payload;
}
