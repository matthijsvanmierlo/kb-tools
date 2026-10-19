import { z } from './zod.js';
import papaLib from 'papaparse';
import { Sanitizer } from './sanitizer.js';
import { defaultAcademicYear } from './academic-year.js';
import { generateUUID } from '../utils/uuid.js';
import { validateQuestion } from '../modules/assignments/question-types.js';

const Papa = papaLib.parse ? papaLib : (papaLib.default || papaLib);

const blank = (v) => (v === null || v === undefined || String(v).trim() === '' ? undefined : String(v).trim());

// --- 1. Zod Domain Schemas ---

export const FSRSStateSchema = z.object({
  state: z.number().int().min(0).max(3).default(0), // 0: New, 1: Learning, 2: Review, 3: Relearning
  due: z.string().default(() => new Date().toISOString()),
  stability: z.number().nonnegative().default(0),
  difficulty: z.number().min(0).max(10).default(0),
  elapsed_days: z.number().nonnegative().default(0),
  scheduled_days: z.number().nonnegative().default(0),
  reps: z.number().int().nonnegative().default(0),
  lapses: z.number().int().nonnegative().default(0),
  last_review: z.string().nullable().optional(),
  due_timestamp: z.number().optional()
});

export const StrokeSchema = z.object({
  color: z.string(),
  size: z.number(),
  mode: z.enum(['pen', 'eraser']),
  points: z.array(z.tuple([z.number(), z.number(), z.number()])) // [x, y, pressure]
});

export const CardSideSchema = z.object({
  text: z.string().default(''),
  mediaUrl: z.string().optional(),
  sketchData: z.array(StrokeSchema).optional(),
  // Card media: idb-blob:// reference locally, data: URL inside shared decks (src/utils/media.js)
  imageRef: z.string().nullable().optional(),
  audioRef: z.string().nullable().optional(),
  ttsLang: z.string().default('en-US')
});

export const FlashcardItemSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['text', 'latex', 'canvas', 'audio']).default('text'),
  front: CardSideSchema,
  back: CardSideSchema,
  srs: z.object({ interval: z.number(), ease: z.number() }).optional(), // Legacy compatibility
  fsrs: FSRSStateSchema.optional()
});

export const FlashcardSetSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().uuid(),
  title: z.string().min(1).max(120),
  description: z.string().optional(),
  class_id: z.string().uuid().nullable().optional(),
  tags: z.array(z.string()).default([]),
  updated_at: z.string().optional(),
  gamification_stats: z.object({
    high_score: z.number().default(0),
    longest_streak: z.number().default(0),
    accuracy: z.number().default(0)
  }).optional(),
  cards: z.array(FlashcardItemSchema).default([])
});

export const TimelineEventSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  start_date: z.string(), // ISO-8601 or signed year string (e.g. "-0044-03-15" or "1517-10-31")
  end_date: z.string().nullable().optional(),
  category: z.string().default('General'),
  description: z.string().default(''),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3b82f6'),
  citations: z.string().optional(),
  mediaUrl: z.string().optional()
});

export const TimelineDatasetSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  class_id: z.string().uuid().nullable().optional(),
  tags: z.array(z.string()).default([]),
  updated_at: z.string().optional(),
  view_state: z.object({
    zoom_level: z.number().default(1),
    focal_epoch_ms: z.number().default(0),
    active_tags: z.array(z.string()).default([])
  }).optional(),
  events: z.array(TimelineEventSchema).default([])
});

export const VideoCheckpointSchema = z.object({
  id: z.string().uuid(),
  timestamp_sec: z.number().nonnegative(),
  type: z.enum(['single_choice', 'multi_choice', 'open_response', 'note']),
  prompt_markdown: z.string().min(1),
  options: z.array(z.object({
    id: z.string(),
    text: z.string(),
    is_correct: z.boolean(),
    rationale: z.string().optional()
  })).optional(),
  keywords: z.array(z.string()).optional(),
  points: z.number().nonnegative().default(1)
});

export const VideoAssessmentSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  class_id: z.string().uuid().nullable().optional(),
  tags: z.array(z.string()).default([]),
  updated_at: z.string().optional(),
  provider: z.enum(['html5', 'youtube', 'vimeo']),
  video_source: z.string().min(1),
  checkpoints: z.array(VideoCheckpointSchema).default([]),
  settings: z.object({
    release_grade_immediately: z.boolean().optional().default(true),
    feedback_mode: z.enum(['immediate', 'after_submit', 'none']).optional().default('immediate'),
    show_correct_answers: z.boolean().optional().default(true)
  }).optional()
});

export const AssignmentSettingsSchema = z.object({
  feedback_mode: z.enum(['immediate', 'after_submit', 'none']).optional().default('after_submit'),
  show_correct_answers: z.boolean().optional().default(false),
  shuffle_questions: z.boolean().optional().default(false),
  shuffle_options: z.boolean().optional().default(true),
  require_access_code: z.boolean().optional().default(true),
  due_date: z.string().optional().default(''),
  release_grade_immediately: z.boolean().optional().default(true)
});

export const AssignmentPayloadSchema = z.object({
  kind: z.literal('kb-assignment').optional(),
  v: z.number().optional(),
  assignment_id: z.string().uuid().optional(),
  course_id: z.string().uuid().nullable().optional(),
  mode: z.enum(['practice', 'graded']).optional(),
  title: z.string().optional(),
  settings: AssignmentSettingsSchema.optional()
}).passthrough();

export const GradebookCourseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  section: z.string().optional(),
  color: z.string().default('#2563eb'),
  updated_at: z.string().optional(),
  created_at: z.string().optional(),
  academic_year: z.string().default(() => defaultAcademicYear()),
  grading_scale: z.enum(['traditional', 'sbg']).default('traditional'),
  archived_at: z.string().nullable().optional(),
  is_demo: z.boolean().optional(),
  terms: z.array(z.object({
    id: z.string(),
    name: z.string(),
    start_date: z.string(),
    end_date: z.string(),
    weight_pct: z.number().min(0).max(100)
  })).default([]),
  categories: z.array(z.object({
    id: z.string(),
    name: z.string(),
    weight_pct: z.number().min(0).max(100),
    drop_lowest: z.number().int().min(0).default(0),
    policy: z.object({
      missing_floor_pct: z.number().min(0).max(100).default(0),
      late_mode: z.enum(['none', 'fixed', 'daily']).default('none'),
      late_deduct_pct: z.number().default(0),
      late_daily_pct: z.number().default(0),
      max_late_cap_pct: z.number().default(50),
      minimum_grade_pct: z.number().default(0)
    }).default({})
  })).default([])
});

export const GradebookStudentSchema = z.object({
  id: z.string().uuid().optional(),
  course_id: z.string().uuid().optional(),
  student_id: z.preprocess(blank, z.string().min(1, 'Student ID is required')),
  full_name: z.preprocess(blank, z.string().min(1, 'Full name is required')),
  given_name: z.preprocess(blank, z.string().optional()),
  family_name: z.preprocess(blank, z.string().optional()),
  email: z.preprocess(blank, z.string().email('Invalid email').optional()),
  access_code: z.preprocess(blank, z.string().optional()),
  notes: z.preprocess(blank, z.string().optional()),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  sis: z.object({
    source: z.string().optional(),
    sourced_id: z.string().optional()
  }).optional(),
  is_demo: z.boolean().optional()
});

export const RosterRowSchema = z.object({
  student_id: z.preprocess(blank, z.string().min(1, 'Student ID is required')),
  full_name: z.preprocess(blank, z.string().optional()),
  given_name: z.preprocess(blank, z.string().optional()),
  family_name: z.preprocess(blank, z.string().optional()),
  email: z.preprocess(blank, z.string().email('Invalid email').optional()),
  access_code: z.preprocess(blank, z.string().optional()),
  notes: z.preprocess(blank, z.string().optional())
}).refine(r => r.full_name || r.given_name || r.family_name, {
  message: 'A name is required',
  path: ['full_name']
});

export const GradebookAssignmentSchema = z.object({
  id: z.string().uuid(),
  course_id: z.string().uuid(),
  term_id: z.string(),
  category_id: z.string(),
  title: z.string().min(1),
  due_date: z.string(),
  max_score: z.number().positive().default(100),
  rubric_id: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  is_demo: z.boolean().optional()
});

export const GradebookGradeSchema = z.object({
  id: z.string().uuid().optional(),
  course_id: z.string().uuid(),
  student_id: z.string(),
  assignment_id: z.string(),
  raw_score: z.number().nullable().optional(),
  status: z.enum(['submitted', 'missing', 'late', 'exempt']).default('submitted'),
  days_late: z.number().nonnegative().default(0),
  rubric_eval: z.record(z.string(), z.string()).optional(), // criterion_id -> tier_id
  feedback: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  is_demo: z.boolean().optional()
});

// --- 2. CSV Header Normalization ---

export const HEADER_ALIASES = {
  'title': 'title',
  'name': 'title',
  'event': 'title',
  'eventname': 'title',
  'event_name': 'title',
  'titel': 'title',
  'startdate': 'start_date',
  'start_date': 'start_date',
  'start date': 'start_date',
  'start': 'start_date',
  'begin': 'start_date',
  'date': 'start_date',
  'datum': 'start_date',
  'begindatum': 'start_date',
  'enddate': 'end_date',
  'end_date': 'end_date',
  'end date': 'end_date',
  'end': 'end_date',
  'einddatum': 'end_date',
  'category': 'category',
  'tag': 'category',
  'type': 'category',
  'categorie': 'category',
  'description': 'description',
  'desc': 'description',
  'notes': 'description',
  'beschrijving': 'description',
  'notities': 'description',
  'color': 'color',
  'colour': 'color',
  'kleur': 'color',
  'citations': 'citations',
  'citation': 'citations',
  'sources': 'citations',
  'source': 'citations',
  'bron': 'citations',
  'bronnen': 'citations',
  'question': 'front',
  'front': 'front',
  'term': 'front',
  'prompt': 'front',
  'cardfront': 'front',
  'fronttext': 'front',
  'prompttext': 'front',
  'vraag': 'front',
  'begrip': 'front',
  'woord': 'front',
  'concept': 'front',
  'card': 'front',
  'answer': 'back',
  'back': 'back',
  'definition': 'back',
  'cardback': 'back',
  'backtext': 'back',
  'response': 'back',
  'antwoord': 'back',
  'definitie': 'back',
  'betekenis': 'back',
  'uitleg': 'back'
};

export const ROSTER_HEADER_ALIASES = {
  'studentid': 'student_id',
  'id': 'student_id',
  'sisid': 'student_id',
  'sisuserid': 'student_id',
  'sisloginid': 'student_id',
  'studentnumber': 'student_id',
  'number': 'student_id',
  'leerlingnummer': 'student_id',
  'leerlingnr': 'student_id',
  'stamnummer': 'student_id',
  'identifier': 'student_id',
  'sourcedid': 'student_id',
  'username': 'student_id',
  'studentname': 'full_name',
  'fullname': 'full_name',
  'name': 'full_name',
  'student': 'full_name',
  'naam': 'full_name',
  'leerling': 'full_name',
  'firstname': 'given_name',
  'first': 'given_name',
  'givenname': 'given_name',
  'voornaam': 'given_name',
  'roepnaam': 'given_name',
  'lastname': 'family_name',
  'last': 'family_name',
  'surname': 'family_name',
  'familyname': 'family_name',
  'achternaam': 'family_name',
  'email': 'email',
  'emailaddress': 'email',
  'mail': 'email',
  'studentemail': 'email',
  'accesscode': 'access_code',
  'code': 'access_code',
  'toegangscode': 'access_code',
  'notes': 'notes',
  'note': 'notes',
  'comments': 'notes',
  'opmerkingen': 'notes'
};

export const ASSIGNMENT_HEADER_ALIASES = {
  'type': 'type',
  'questiontype': 'type',
  'qtype': 'type',
  'kind': 'type',
  'prompt': 'prompt',
  'question': 'prompt',
  'questiontext': 'prompt',
  'vraag': 'prompt',
  'points': 'points',
  'point': 'points',
  'pts': 'points',
  'score': 'points',
  'punten': 'points',
  'correctanswer': 'correct_answer',
  'correct': 'correct_answer',
  'answer': 'correct_answer',
  'key': 'correct_answer',
  'correct_answer': 'correct_answer',
  'antwoord': 'correct_answer',
  'optiona': 'option_a',
  'option_a': 'option_a',
  'option1': 'option_a',
  'a': 'option_a',
  'optionb': 'option_b',
  'option_b': 'option_b',
  'option2': 'option_b',
  'b': 'option_b',
  'optionc': 'option_c',
  'option_c': 'option_c',
  'option3': 'option_c',
  'c': 'option_c',
  'optiond': 'option_d',
  'option_d': 'option_d',
  'option4': 'option_d',
  'd': 'option_d',
  'optione': 'option_e',
  'option_e': 'option_e',
  'option5': 'option_e',
  'e': 'option_e',
  'optionf': 'option_f',
  'option_f': 'option_f',
  'option6': 'option_f',
  'f': 'option_f',
  'options': 'options',
  'choices': 'options',
  'keuzes': 'options',
  'opties': 'options',
  'explanation': 'explanation',
  'feedback': 'explanation',
  'rationale': 'explanation',
  'uitleg': 'explanation',
  'toelichting': 'explanation',
  'rubric': 'rubric_hint',
  'rubrichint': 'rubric_hint',
  'rubric_hint': 'rubric_hint',
  'tolerance': 'tolerance',
  'tolerantie': 'tolerance',
  'tolerancetype': 'tolerance_type',
  'tolerance_type': 'tolerance_type',
  'unit': 'unit',
  'eenheid': 'unit',
  'scoring': 'scoring',
  'scoringrule': 'scoring',
  'distractors': 'distractors',
  'casesensitive': 'case_sensitive',
  'case_sensitive': 'case_sensitive',
  'allowtypo': 'allow_typo',
  'allow_typo': 'allow_typo'
};

const TYPE_ALIASES = {
  single_choice: 'single_choice',
  mc: 'single_choice',
  multiple_choice: 'single_choice',
  single: 'single_choice',
  choice: 'single_choice',

  multi_choice: 'multi_choice',
  multi: 'multi_choice',
  checkbox: 'multi_choice',
  select_all: 'multi_choice',
  multiple_select: 'multi_choice',

  true_false: 'true_false',
  tf: 'true_false',
  'true/false': 'true_false',
  boolean: 'true_false',

  short_text: 'short_text',
  short: 'short_text',
  short_answer: 'short_text',
  text: 'short_text',

  numeric: 'numeric',
  number: 'numeric',
  math: 'numeric',
  numeric_value: 'numeric',
  calc: 'numeric',

  fill_blank: 'fill_blank',
  blank: 'fill_blank',
  blanks: 'fill_blank',
  cloze: 'fill_blank',
  fill_in_the_blank: 'fill_blank',

  ordering: 'ordering',
  order: 'ordering',
  sequence: 'ordering',
  sort: 'ordering',

  matching: 'matching',
  match: 'matching',
  pairs: 'matching',

  long_text: 'long_text',
  essay: 'long_text',
  long: 'long_text',
  open: 'long_text',
  free_response: 'long_text',
  long_response: 'long_text'
};

export function normalizeAssignmentQuestionRow(rawRow) {
  if (!rawRow || typeof rawRow !== 'object') {
    return { id: generateUUID(), type: 'short_text', prompt: '', points: 1 };
  }

  const getField = (...names) => {
    for (const name of names) {
      if (rawRow[name] !== undefined && rawRow[name] !== null && String(rawRow[name]).trim() !== '') {
        return rawRow[name];
      }
    }
    return '';
  };

  const rawType = String(getField('type', 'questiontype', 'qtype', 'kind')).trim().toLowerCase();
  const rawPrompt = String(getField('prompt', 'question', 'questiontext', 'vraag')).trim();
  const rawPoints = getField('points', 'point', 'pts', 'score', 'punten');
  const rawCorrect = String(getField('correct_answer', 'correctanswer', 'answer', 'key', 'correct', 'antwoord')).trim();
  const rawExplanation = String(getField('explanation', 'feedback', 'rationale', 'uitleg', 'toelichting')).trim();
  const rawTolerance = String(getField('tolerance', 'tolerantie')).trim();
  const rawUnit = String(getField('unit', 'eenheid')).trim();
  const rawScoring = String(getField('scoring', 'scoringrule')).trim().toLowerCase();
  const rawRubric = String(getField('rubric_hint', 'rubrichint', 'rubric')).trim();
  const rawDistractors = String(getField('distractors')).trim();

  // Gather OptionA through OptionF
  const optionCells = [
    String(getField('option_a', 'optiona', 'option1', 'a') || '').trim(),
    String(getField('option_b', 'optionb', 'option2', 'b') || '').trim(),
    String(getField('option_c', 'optionc', 'option3', 'c') || '').trim(),
    String(getField('option_d', 'optiond', 'option4', 'd') || '').trim(),
    String(getField('option_e', 'optione', 'option5', 'e') || '').trim(),
    String(getField('option_f', 'optionf', 'option6', 'f') || '').trim()
  ].filter(Boolean);

  const rawOptionsField = String(getField('options', 'choices', 'keuzes', 'opties')).trim();
  const allOptionTexts = optionCells.length > 0
    ? optionCells
    : (rawOptionsField ? rawOptionsField.split(/[|;]/).map(s => s.trim()).filter(Boolean) : []);

  // Normalize prompt: replace 3+ underscores with [[blank]]
  const normalizedPrompt = rawPrompt.replace(/___+/g, '[[blank]]');

  // Resolve question type alias
  let resolvedType = TYPE_ALIASES[rawType] || rawType;

  // Auto-infer type if missing
  if (!resolvedType) {
    if (normalizedPrompt.includes('[[blank]]')) {
      resolvedType = 'fill_blank';
    } else if (rawTolerance || rawUnit) {
      resolvedType = 'numeric';
    } else if (/^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/.test(rawCorrect) && allOptionTexts.length === 0) {
      resolvedType = 'numeric';
    } else if (/^(true|false|t|f|yes|no|1|0)$/i.test(rawCorrect) && allOptionTexts.length === 0) {
      resolvedType = 'true_false';
    } else if (allOptionTexts.some(o => o.includes('->') || o.includes(' : ') || o.includes(' = '))) {
      resolvedType = 'matching';
    } else if (allOptionTexts.length >= 2) {
      if (rawCorrect.includes(';') || rawCorrect.includes('|') || (rawCorrect.includes(',') && !rawCorrect.includes(' '))) {
        resolvedType = 'multi_choice';
      } else {
        resolvedType = 'single_choice';
      }
    } else if (rawRubric) {
      resolvedType = 'long_text';
    } else if (rawPoints || getField('type', 'questiontype', 'qtype', 'kind')) {
      resolvedType = 'short_text';
    } else {
      resolvedType = '';
    }
  }

  const id = (rawRow.id && typeof rawRow.id === 'string' && rawRow.id.length >= 16) ? rawRow.id : generateUUID();
  const points = (rawPoints !== '' && !Number.isNaN(Number(rawPoints))) ? Math.max(0, Number(rawPoints)) : (
    resolvedType === 'multi_choice' || resolvedType === 'fill_blank' || resolvedType === 'ordering' ? 2 :
    resolvedType === 'matching' ? 3 :
    resolvedType === 'long_text' ? 4 : 1
  );

  const q = {
    id,
    type: resolvedType,
    prompt: normalizedPrompt,
    points,
    explanation: rawExplanation
  };

  switch (resolvedType) {
    case 'single_choice': {
      let correctIdx = -1;
      const upperCorrect = rawCorrect.toUpperCase();
      if (/^[A-F]$/.test(upperCorrect)) {
        correctIdx = upperCorrect.charCodeAt(0) - 65;
      } else if (/^[1-6]$/.test(rawCorrect)) {
        correctIdx = parseInt(rawCorrect, 10) - 1;
      } else if (rawCorrect) {
        correctIdx = allOptionTexts.findIndex(t => t.toLowerCase() === rawCorrect.toLowerCase());
      }
      q.options = allOptionTexts.map((text, idx) => ({
        id: generateUUID().slice(0, 8),
        text,
        is_correct: idx === correctIdx
      }));
      break;
    }

    case 'multi_choice': {
      const tokens = rawCorrect ? rawCorrect.split(/[;|,]/).map(s => s.trim()).filter(Boolean) : [];
      const correctIndices = new Set();
      for (const tok of tokens) {
        const u = tok.toUpperCase();
        if (/^[A-F]$/.test(u)) {
          correctIndices.add(u.charCodeAt(0) - 65);
        } else if (/^[1-6]$/.test(tok)) {
          correctIndices.add(parseInt(tok, 10) - 1);
        } else {
          const matchIdx = allOptionTexts.findIndex(t => t.toLowerCase() === tok.toLowerCase());
          if (matchIdx !== -1) correctIndices.add(matchIdx);
        }
      }
      q.options = allOptionTexts.map((text, idx) => ({
        id: generateUUID().slice(0, 8),
        text,
        is_correct: correctIndices.has(idx)
      }));
      q.scoring = rawScoring === 'all_or_nothing' ? 'all_or_nothing' : 'partial';
      break;
    }

    case 'true_false': {
      const lower = rawCorrect.toLowerCase();
      q.correct = ['true', 't', 'yes', '1', 'waar', 'juist'].includes(lower);
      break;
    }

    case 'short_text': {
      const acceptedAnswers = new Set();
      if (rawCorrect) {
        rawCorrect.split(/[;|]/).map(s => s.trim()).filter(Boolean).forEach(s => acceptedAnswers.add(s));
      }
      allOptionTexts.forEach(s => {
        if (s) acceptedAnswers.add(s);
      });
      q.accepted = Array.from(acceptedAnswers);
      q.case_sensitive = rawScoring === 'case_sensitive' || rawRow.case_sensitive === true || rawRow.case_sensitive === 'true';
      q.allow_typo = rawRow.allow_typo !== false && rawRow.allow_typo !== 'false';
      break;
    }

    case 'numeric': {
      const cleanNum = rawCorrect.replace(/,/g, '.');
      q.target = cleanNum !== '' && !Number.isNaN(Number(cleanNum)) ? Number(cleanNum) : NaN;
      if (rawTolerance.endsWith('%')) {
        q.tolerance = parseFloat(rawTolerance) || 0;
        q.tolerance_type = 'percent';
      } else {
        q.tolerance = rawTolerance !== '' ? parseFloat(rawTolerance.replace(/,/g, '.')) || 0 : 0;
        q.tolerance_type = 'absolute';
      }
      q.unit = rawUnit;
      break;
    }

    case 'fill_blank': {
      const blankCount = (normalizedPrompt.match(/\[\[blank\]\]/gi) || []).length;
      const blanks = [];
      const correctParts = rawCorrect ? rawCorrect.split(';').map(p => p.trim()) : [];

      const count = Math.max(blankCount, allOptionTexts.length, correctParts.length, 1);
      for (let i = 0; i < count; i++) {
        const accepted = new Set();
        if (correctParts[i]) {
          correctParts[i].split('|').map(s => s.trim()).filter(Boolean).forEach(s => accepted.add(s));
        }
        if (allOptionTexts[i]) {
          allOptionTexts[i].split('|').map(s => s.trim()).filter(Boolean).forEach(s => accepted.add(s));
        }
        blanks.push({ accepted: Array.from(accepted) });
      }
      q.blanks = blanks;
      q.scoring = rawScoring === 'all_or_nothing' ? 'all_or_nothing' : 'partial';
      q.allow_typo = false;
      break;
    }

    case 'ordering': {
      const items = allOptionTexts.length > 0
        ? allOptionTexts
        : (rawCorrect ? rawCorrect.split(/[;|]/).map(s => s.trim()).filter(Boolean) : []);
      q.items = items.map(text => ({ id: generateUUID().slice(0, 8), text }));
      q.scoring = rawScoring === 'all_or_nothing' ? 'all_or_nothing' : 'partial';
      break;
    }

    case 'matching': {
      const rawPairs = allOptionTexts.length > 0 ? allOptionTexts : (rawCorrect ? rawCorrect.split(';').map(s => s.trim()).filter(Boolean) : []);
      const pairs = [];
      const distractors = new Set();

      for (const item of rawPairs) {
        let left = '';
        let right = '';
        if (item.includes('->')) {
          [left, right] = item.split('->').map(s => s.trim());
        } else if (item.includes(' : ')) {
          [left, right] = item.split(' : ').map(s => s.trim());
        } else if (item.includes(' = ')) {
          [left, right] = item.split(' = ').map(s => s.trim());
        } else if (item.includes(':')) {
          [left, right] = item.split(':').map(s => s.trim());
        } else {
          distractors.add(item);
          continue;
        }
        if (left && right) {
          pairs.push({ id: generateUUID().slice(0, 8), left, right });
        } else if (item) {
          distractors.add(item);
        }
      }

      if (rawDistractors) {
        rawDistractors.split(/[;|]/).map(s => s.trim()).filter(Boolean).forEach(d => distractors.add(d));
      }

      q.pairs = pairs;
      q.distractors = Array.from(distractors);
      q.scoring = rawScoring === 'all_or_nothing' ? 'all_or_nothing' : 'partial';
      break;
    }

    case 'long_text': {
      q.rubric_hint = rawRubric || rawCorrect || '';
      break;
    }

    default:
      break;
  }

  return q;
}

export const AssignmentQuestionRowSchema = z.any().transform(rawRow => {
  return normalizeAssignmentQuestionRow(rawRow);
}).superRefine((q, ctx) => {
  const validTypes = ['single_choice', 'multi_choice', 'true_false', 'numeric', 'short_text', 'fill_blank', 'ordering', 'matching', 'long_text'];
  if (!validTypes.includes(q.type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid or missing question type: "${q.type}"`,
      path: ['Type']
    });
    return;
  }
  const issues = validateQuestion(q);
  if (issues && issues.length > 0) {
    for (const msg of issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: msg,
        path: ['CorrectAnswer']
      });
    }
  }
});

/**
 * Universal CSV Import Pipeline with deterministic schema validation and error reporting
 * @param {string} csvString
 * @param {z.ZodSchema} schema - Zod schema for a single item/row
 * @param {object} [options]
 * @returns {{ success: boolean, data?: any[], errors?: Array<{ rowNumber: number, fieldPath: string, message: string, receivedValue: any }> }}
 */
export function parseCSVWithValidation(csvString, schema, options = {}) {
  const { aliases, dynamicTyping, ...papaOpts } = options;
  const activeAliases = aliases || (
    schema === RosterRowSchema ? ROSTER_HEADER_ALIASES :
    schema === AssignmentQuestionRowSchema ? ASSIGNMENT_HEADER_ALIASES :
    HEADER_ALIASES
  );
  const effectiveDynamicTyping = dynamicTyping !== undefined
    ? dynamicTyping
    : (schema === RosterRowSchema || schema === AssignmentQuestionRowSchema ? false : true);

  // Check if first row is a header row or raw data
  const rawParsed = Papa.parse(csvString, {
    header: false,
    dynamicTyping: effectiveDynamicTyping,
    skipEmptyLines: 'greedy',
    ...papaOpts
  });

  if (rawParsed.errors && rawParsed.errors.length > 0) {
    const csvErrors = rawParsed.errors.map(err => ({
      rowNumber: (err.row ?? 0) + 1,
      fieldPath: 'csv_syntax',
      message: err.message,
      receivedValue: null
    }));
    return { success: false, errors: csvErrors };
  }

  const matrix = rawParsed.data || [];
  if (matrix.length === 0) {
    return { success: true, data: [] };
  }

  const firstRow = matrix[0] || [];
  const matchCount = firstRow.filter(cell => {
    const raw = String(cell || '').trim().replace(/^\uFEFF/, '');
    const normalized = raw.toLowerCase().replace(/[\s_\-\.]+/g, '');
    const lower = raw.toLowerCase();
    return Boolean(activeAliases[normalized] || activeAliases[lower]);
  }).length;

  const hasHeaderRow = matchCount >= 1 && (firstRow.length <= 2 || matchCount >= 2);

  let parsedRows = [];
  let headerOffset = 1;

  if (hasHeaderRow) {
    headerOffset = 2;
    const headerCols = firstRow.map(h => {
      const raw = String(h || '').trim().replace(/^\uFEFF/, '');
      const normalized = raw.toLowerCase().replace(/[\s_\-\.]+/g, '');
      if (activeAliases[normalized]) return activeAliases[normalized];
      const lower = raw.toLowerCase();
      if (activeAliases[lower]) return activeAliases[lower];
      return raw;
    });

    const dataRows = matrix.slice(1);
    parsedRows = dataRows.map((r, rowIdx) => {
      const obj = {};
      headerCols.forEach((col, cIdx) => {
        obj[col] = r[cIdx];
      });
      return { obj, rowNumber: rowIdx + headerOffset };
    });
  } else {
    // No explicit header row: map positional columns based on schema
    headerOffset = 1;
    parsedRows = matrix.map((r, rowIdx) => {
      const obj = {};
      if (schema === FlashcardItemSchema) {
        obj.front = r[0];
        obj.back = r[1];
      } else if (schema === TimelineEventSchema) {
        obj.title = r[0];
        obj.start_date = r[1];
        if (r[2] !== undefined) obj.end_date = r[2];
        if (r[3] !== undefined) obj.category = r[3];
        if (r[4] !== undefined) obj.description = r[4];
        if (r[5] !== undefined) obj.color = r[5];
        if (r[6] !== undefined) obj.citations = r[6];
      } else if (schema === AssignmentQuestionRowSchema) {
        obj.type = r[0];
        obj.prompt = r[1];
        if (r[2] !== undefined) obj.points = r[2];
        if (r[3] !== undefined) obj.correct_answer = r[3];
        if (r[4] !== undefined) obj.option_a = r[4];
        if (r[5] !== undefined) obj.option_b = r[5];
        if (r[6] !== undefined) obj.option_c = r[6];
        if (r[7] !== undefined) obj.option_d = r[7];
        if (r[8] !== undefined) obj.explanation = r[8];
        if (r[9] !== undefined) obj.tolerance = r[9];
        if (r[10] !== undefined) obj.unit = r[10];
        if (r[11] !== undefined) obj.scoring = r[11];
      } else {
        r.forEach((val, idx) => { obj[`col_${idx}`] = val; });
      }
      return { obj, rowNumber: rowIdx + headerOffset };
    });
  }

  const errors = [];
  const validatedData = [];

  for (const { obj: rawRow, rowNumber } of parsedRows) {
    let row = { ...rawRow };

    // Specific pre-normalizations for common entities:
    // 1. Flashcards: front & back text objects
    if (schema === FlashcardItemSchema || row.front !== undefined || row.back !== undefined) {
      const frontVal = row.front !== undefined && row.front !== null
        ? (typeof row.front === 'object' && row.front.text !== undefined ? row.front.text : String(row.front).trim())
        : '';
      const backVal = row.back !== undefined && row.back !== null
        ? (typeof row.back === 'object' && row.back.text !== undefined ? row.back.text : String(row.back).trim())
        : '';

      // Skip completely empty lines
      if (!frontVal && !backVal) continue;

      row = {
        id: (typeof row.id === 'string' && row.id.length >= 32) ? row.id : crypto.randomUUID(),
        type: row.type || 'text',
        front: { text: frontVal, ttsLang: row.tts_lang || (row.front?.ttsLang) || 'en-US' },
        back: { text: backVal, ttsLang: row.tts_lang || (row.back?.ttsLang) || 'en-US' }
      };
    }

    // 2. Timelines: empty end_date to null and stringify numeric dates/titles
    if (schema === TimelineEventSchema || row.start_date !== undefined) {
      if (!row.id) {
        row.id = crypto.randomUUID();
      }
      if (row.title !== undefined && row.title !== null && typeof row.title !== 'string') {
        row.title = String(row.title).trim();
      }
      if (row.start_date !== undefined && row.start_date !== null && typeof row.start_date !== 'string') {
        row.start_date = String(row.start_date).trim();
      }
      if (row.end_date === '' || row.end_date === undefined || row.end_date === null) {
        row.end_date = null;
      } else if (typeof row.end_date !== 'string') {
        row.end_date = String(row.end_date).trim();
      }
      if (row.color && !row.color.startsWith('#')) {
        row.color = `#${row.color}`;
      }
    }

    const result = schema.safeParse(row);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          rowNumber,
          fieldPath: issue.path.join('.') || 'root',
          message: issue.message,
          receivedValue: issue.path.reduce((obj, p) => (obj ? obj[p] : undefined), row)
        });
      }
    } else {
      validatedData.push(result.data);
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, data: validatedData };
}

/**
 * Display atomic import validation rollback modal
 * @param {Array<{ rowNumber: number, fieldPath: string, message: string, receivedValue: any }>} errors
 */
export function showImportErrorsDialog(errors) {
  if (typeof document === 'undefined') return;

  const existing = document.getElementById('sl-import-error-dialog');
  if (existing) existing.remove();

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'sl-import-error-dialog';
  dialog.label = 'Import Validation Failed';
  dialog.style.setProperty('--width', '680px');

  const rowsHtml = errors.slice(0, 50).map(err => `
    <tr class="border-b text-xs">
      <td class="p-2 font-mono text-center">${err.rowNumber}</td>
      <td class="p-2 font-mono text-blue-600">${Sanitizer.escapeHTML(err.fieldPath)}</td>
      <td class="p-2 text-red-600">${Sanitizer.escapeHTML(err.message)}</td>
      <td class="p-2 font-mono text-slate-500 truncate max-w-xs">${Sanitizer.escapeHTML(String(err.receivedValue ?? ''))}</td>
    </tr>
  `).join('');

  dialog.innerHTML = `
    <div class="space-y-4">
      <p class="text-sm text-slate-700">
        The file could not be imported because <strong>${errors.length} validation error(s)</strong> were detected.
        No database records were changed (atomic transaction rollback).
      </p>
      <div class="overflow-x-auto max-h-72 border rounded">
        <table class="w-full text-left">
          <thead class="bg-slate-100 text-xs font-semibold text-slate-700">
            <tr>
              <th class="p-2 text-center">Row</th>
              <th class="p-2">Field</th>
              <th class="p-2">Error</th>
              <th class="p-2">Received Value</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
      ${errors.length > 50 ? `<p class="text-xs text-slate-500">Showing first 50 of ${errors.length} errors.</p>` : ''}
    </div>
    <sl-button slot="footer" variant="primary" id="btn-close-error-dialog">Close</sl-button>
  `;

  document.body.appendChild(dialog);
  dialog.show();

  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target === dialog) dialog.remove();
  });

  const closeBtn = dialog.querySelector('#btn-close-error-dialog');
  if (closeBtn) closeBtn.addEventListener('click', () => dialog.hide());
}

// --- 3. Universal Exporter Factory ---

export class Exporter {
  /**
   * Export dataset to CSV string
   * @param {any[]} dataset
   * @param {z.ZodSchema} [schema]
   * @returns {string} CSV text
   */
  static toCSV(dataset, schema) {
    if (!Array.isArray(dataset)) dataset = [dataset];

    // Flatten common nested objects
    const flattened = dataset.map(item => {
      const flat = { ...item };
      // Flatten flashcard front/back if present
      if (flat.front && typeof flat.front === 'object') {
        flat.question = flat.front.text || '';
        flat.tts_lang = flat.front.ttsLang || 'en-US';
        delete flat.front;
      }
      if (flat.back && typeof flat.back === 'object') {
        flat.answer = flat.back.text || '';
        delete flat.back;
      }
      // Remove complex objects that shouldn't appear in flat CSV
      delete flat.fsrs;
      delete flat.srs;
      delete flat.gamification_stats;
      return flat;
    });

    return Papa.unparse(flattened, {
      quotes: true,
      header: true
    });
  }

  /**
   * Export an assignment or questions array to canonical 12-column spreadsheet CSV
   * @param {object|Array<object>} assignmentOrQuestions
   * @returns {string} CSV text
   */
  static assignmentToCSV(assignmentOrQuestions) {
    const questions = Array.isArray(assignmentOrQuestions)
      ? assignmentOrQuestions
      : (assignmentOrQuestions?.questions || []);

    const rows = questions.map(q => {
      const type = q.type || 'single_choice';
      const prompt = q.prompt || '';
      const points = q.points !== undefined ? q.points : 1;
      const explanation = q.explanation || '';
      let correctAnswer = '';
      let optA = '';
      let optB = '';
      let optC = '';
      let optD = '';
      let tolerance = '';
      let unit = '';
      let scoring = q.scoring || '';

      switch (type) {
        case 'single_choice': {
          const opts = q.options || [];
          optA = opts[0]?.text || '';
          optB = opts[1]?.text || '';
          optC = opts[2]?.text || '';
          optD = opts[3]?.text || '';
          const correctIdx = opts.findIndex(o => o.is_correct);
          if (correctIdx >= 0) {
            correctAnswer = String.fromCharCode(65 + correctIdx);
          }
          break;
        }

        case 'multi_choice': {
          const opts = q.options || [];
          optA = opts[0]?.text || '';
          optB = opts[1]?.text || '';
          optC = opts[2]?.text || '';
          optD = opts[3]?.text || '';
          const correctLetters = opts
            .map((o, idx) => o.is_correct ? String.fromCharCode(65 + idx) : null)
            .filter(Boolean);
          correctAnswer = correctLetters.join('; ');
          scoring = q.scoring || 'partial';
          break;
        }

        case 'true_false': {
          correctAnswer = q.correct ? 'True' : 'False';
          break;
        }

        case 'short_text': {
          correctAnswer = (q.accepted || []).join(' | ');
          if (q.case_sensitive) scoring = 'case_sensitive';
          break;
        }

        case 'numeric': {
          correctAnswer = q.target !== undefined && q.target !== null ? String(q.target) : '';
          tolerance = q.tolerance !== undefined && q.tolerance !== null
            ? (q.tolerance_type === 'percent' ? `${q.tolerance}%` : String(q.tolerance))
            : '';
          unit = q.unit || '';
          break;
        }

        case 'fill_blank': {
          const blanks = q.blanks || [];
          correctAnswer = blanks.map(b => (b.accepted || []).join(' | ')).join('; ');
          optA = (blanks[0]?.accepted || []).join(' | ');
          optB = (blanks[1]?.accepted || []).join(' | ');
          optC = (blanks[2]?.accepted || []).join(' | ');
          optD = (blanks[3]?.accepted || []).join(' | ');
          scoring = q.scoring || 'partial';
          break;
        }

        case 'ordering': {
          const items = q.items || [];
          optA = items[0]?.text || '';
          optB = items[1]?.text || '';
          optC = items[2]?.text || '';
          optD = items[3]?.text || '';
          scoring = q.scoring || 'partial';
          break;
        }

        case 'matching': {
          const pairs = q.pairs || [];
          optA = pairs[0] ? `${pairs[0].left} -> ${pairs[0].right}` : '';
          optB = pairs[1] ? `${pairs[1].left} -> ${pairs[1].right}` : '';
          optC = pairs[2] ? `${pairs[2].left} -> ${pairs[2].right}` : '';
          optD = pairs[3] ? `${pairs[3].left} -> ${pairs[3].right}` : '';
          correctAnswer = (q.distractors || []).join(' | ');
          scoring = q.scoring || 'partial';
          break;
        }

        case 'long_text': {
          correctAnswer = q.rubric_hint || '';
          break;
        }

        default:
          break;
      }

      return {
        Type: type,
        Prompt: prompt,
        Points: points,
        CorrectAnswer: correctAnswer,
        OptionA: optA,
        OptionB: optB,
        OptionC: optC,
        OptionD: optD,
        Explanation: explanation,
        Tolerance: tolerance,
        Unit: unit,
        Scoring: scoring
      };
    });

    return Papa.unparse(rows, {
      quotes: true,
      header: true,
      columns: ['Type', 'Prompt', 'Points', 'CorrectAnswer', 'OptionA', 'OptionB', 'OptionC', 'OptionD', 'Explanation', 'Tolerance', 'Unit', 'Scoring']
    });
  }

  /**
   * Export dataset to pretty JSON
   * @param {*} dataset
   * @param {number} [version=1]
   * @returns {string} JSON string
   */
  static toJSON(dataset, version = 1) {
    const wrapped = {
      version,
      exported_at: new Date().toISOString(),
      data: dataset
    };
    return JSON.stringify(wrapped, null, 2);
  }

  /**
   * Export dataset to GitHub Flavored Markdown (GFM)
   * @param {any[]} dataset
   * @param {'flashcards' | 'timeline' | 'gradebook'} type
   * @returns {string} Markdown text
   */
  static toMarkdown(dataset, type = 'flashcards') {
    if (!Array.isArray(dataset)) dataset = [dataset];

    if (type === 'flashcards') {
      let md = '# Flashcard Deck\n\n| # | Front (Question) | Back (Answer) |\n|---|---|---|\n';
      dataset.forEach((card, i) => {
        const front = (card.front?.text || card.question || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
        const back = (card.back?.text || card.answer || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
        md += `| ${i + 1} | ${front} | ${back} |\n`;
      });
      return md;
    }

    if (type === 'timeline') {
      let md = '# Timeline Events\n\n';
      const sorted = [...dataset].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
      for (const ev of sorted) {
        const span = ev.end_date ? ` to ${ev.end_date}` : '';
        md += `### ${ev.title} (${ev.start_date}${span})\n`;
        md += `- **Category:** ${ev.category || 'General'}\n`;
        if (ev.description) md += `- **Description:** ${ev.description}\n`;
        if (ev.citations) md += `- **Citations:** ${ev.citations}\n`;
        md += '\n';
      }
      return md;
    }

    if (type === 'gradebook') {
      let md = '# Gradebook Report\n\n| Student Name | ID | Score | Status |\n|---|---|---|---|\n';
      dataset.forEach(row => {
        md += `| ${row.full_name || ''} | ${row.student_id || ''} | ${row.score ?? ''} | ${row.status || ''} |\n`;
      });
      return md;
    }

    return JSON.stringify(dataset, null, 2);
  }
}
