import { generateUUID } from '../../utils/uuid.js';

/**
 * Question type catalogue: labels, icons and blank templates for the editor.
 */
export const QUESTION_TYPE_META = {
  single_choice: { label: 'Multiple choice', icon: 'ui-radios', help: 'One correct option.', auto: true },
  multi_choice: { label: 'Select all that apply', icon: 'ui-checks-grid', help: 'Several correct options, optional partial credit.', auto: true },
  true_false: { label: 'True / False', icon: 'toggle2-on', help: 'A single statement.', auto: true },
  short_text: { label: 'Short answer', icon: 'input-cursor-text', help: 'Matched against accepted answers.', auto: true },
  numeric: { label: 'Numeric', icon: '123', help: 'A number with tolerance and optional unit.', auto: true },
  fill_blank: { label: 'Fill in the blanks', icon: 'textarea-t', help: 'Type [[blank]] where each gap goes.', auto: true },
  ordering: { label: 'Ordering', icon: 'sort-numeric-down', help: 'Students put items in the right order.', auto: true },
  matching: { label: 'Matching', icon: 'arrow-left-right', help: 'Match each prompt to an answer.', auto: true },
  long_text: { label: 'Long response', icon: 'card-text', help: 'Open answer, graded by you.', auto: false }
};

export const QUESTION_TYPE_ORDER = Object.keys(QUESTION_TYPE_META);

const opt = (text, is_correct = false) => ({ id: generateUUID().slice(0, 8), text, is_correct });

export function createQuestion(type) {
  const base = { id: generateUUID(), type, prompt: '', points: 1, explanation: '' };
  switch (type) {
    case 'single_choice':
      return { ...base, options: [opt('', true), opt(''), opt(''), opt('')] };
    case 'multi_choice':
      return { ...base, points: 2, scoring: 'partial', options: [opt('', true), opt('', true), opt(''), opt('')] };
    case 'true_false':
      return { ...base, correct: true };
    case 'short_text':
      return { ...base, accepted: [], case_sensitive: false, allow_typo: true };
    case 'numeric':
      return { ...base, target: 0, tolerance: 0, tolerance_type: 'absolute', unit: '' };
    case 'fill_blank':
      return { ...base, prompt: 'The [[blank]] is …', blanks: [{ accepted: [] }], scoring: 'partial', allow_typo: false };
    case 'ordering':
      return { ...base, points: 2, scoring: 'partial', items: [{ id: generateUUID().slice(0, 8), text: '' }, { id: generateUUID().slice(0, 8), text: '' }, { id: generateUUID().slice(0, 8), text: '' }] };
    case 'matching':
      return { ...base, points: 3, scoring: 'partial', pairs: [{ id: generateUUID().slice(0, 8), left: '', right: '' }, { id: generateUUID().slice(0, 8), left: '', right: '' }], distractors: [] };
    case 'long_text':
      return { ...base, points: 4, rubric_hint: '' };
    default:
      return base;
  }
}

/** Deep copy with fresh ids (for duplicating questions or assignments) */
export function cloneQuestion(q) {
  const c = JSON.parse(JSON.stringify(q));
  c.id = generateUUID();
  if (Array.isArray(c.options)) c.options = c.options.map(o => ({ ...o, id: generateUUID().slice(0, 8) }));
  if (Array.isArray(c.items)) c.items = c.items.map(i => ({ ...i, id: generateUUID().slice(0, 8) }));
  if (Array.isArray(c.pairs)) c.pairs = c.pairs.map(p => ({ ...p, id: generateUUID().slice(0, 8) }));
  return c;
}

/** Problems that would make a question ungradeable; shown as warnings in the editor */
export function validateQuestion(q) {
  const issues = [];
  if (!String(q.prompt || '').trim()) issues.push('Add a prompt.');
  switch (q.type) {
    case 'single_choice':
      if ((q.options || []).filter(o => String(o.text).trim()).length < 2) issues.push('Add at least two options.');
      if ((q.options || []).filter(o => o.is_correct).length !== 1) issues.push('Mark exactly one correct option.');
      break;
    case 'multi_choice':
      if ((q.options || []).filter(o => String(o.text).trim()).length < 2) issues.push('Add at least two options.');
      if (!(q.options || []).some(o => o.is_correct)) issues.push('Mark at least one correct option.');
      break;
    case 'short_text':
      if (!(q.accepted || []).length) issues.push('Add at least one accepted answer.');
      break;
    case 'numeric':
      if (!Number.isFinite(Number(q.target))) issues.push('Enter a numeric target.');
      break;
    case 'fill_blank': {
      const n = (String(q.prompt || '').match(/\[\[blank\]\]/gi) || []).length;
      if (n === 0) issues.push('Type [[blank]] in the prompt for each gap.');
      if ((q.blanks || []).some(b => !(b.accepted || []).length)) issues.push('Every blank needs an accepted answer.');
      break;
    }
    case 'ordering':
      if ((q.items || []).filter(i => String(i.text).trim()).length < 2) issues.push('Add at least two items.');
      break;
    case 'matching':
      if ((q.pairs || []).filter(p => String(p.left).trim() && String(p.right).trim()).length < 2) issues.push('Add at least two complete pairs.');
      break;
    default:
      break;
  }
  return issues;
}
