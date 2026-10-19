import { z } from './zod.js';
import papaLib from 'papaparse';
import { Sanitizer } from './sanitizer.js';
import { defaultAcademicYear } from './academic-year.js';

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
  checkpoints: z.array(VideoCheckpointSchema).default([])
});

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
  'startdate': 'start_date',
  'start_date': 'start_date',
  'start date': 'start_date',
  'start': 'start_date',
  'begin': 'start_date',
  'date': 'start_date',
  'enddate': 'end_date',
  'end_date': 'end_date',
  'end date': 'end_date',
  'end': 'end_date',
  'category': 'category',
  'tag': 'category',
  'type': 'category',
  'description': 'description',
  'desc': 'description',
  'notes': 'description',
  'color': 'color',
  'colour': 'color',
  'citations': 'citations',
  'citation': 'citations',
  'sources': 'citations',
  'source': 'citations',
  'question': 'front',
  'front': 'front',
  'term': 'front',
  'prompt': 'front',
  'answer': 'back',
  'back': 'back',
  'definition': 'back'
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

/**
 * Universal CSV Import Pipeline with deterministic schema validation and error reporting
 * @param {string} csvString
 * @param {z.ZodSchema} schema - Zod schema for a single item/row
 * @param {object} [options]
 * @returns {{ success: boolean, data?: any[], errors?: Array<{ rowNumber: number, fieldPath: string, message: string, receivedValue: any }> }}
 */
export function parseCSVWithValidation(csvString, schema, options = {}) {
  const { aliases, dynamicTyping, ...papaOpts } = options;

  const activeAliases = aliases || (schema === RosterRowSchema ? ROSTER_HEADER_ALIASES : HEADER_ALIASES);
  const effectiveDynamicTyping = dynamicTyping !== undefined
    ? dynamicTyping
    : (schema === RosterRowSchema ? false : true);

  const parsed = Papa.parse(csvString, {
    header: true,
    dynamicTyping: effectiveDynamicTyping,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => {
      const raw = (h || '').trim();
      const normalized = raw.toLowerCase().replace(/[\s_\-\.]+/g, '');
      if (activeAliases[normalized]) return activeAliases[normalized];
      const lower = raw.toLowerCase();
      if (activeAliases[lower]) return activeAliases[lower];
      return raw;
    },
    ...papaOpts
  });

  if (parsed.errors && parsed.errors.length > 0) {
    const csvErrors = parsed.errors.map(err => ({
      rowNumber: (err.row ?? 0) + 2, // header is row 1
      fieldPath: 'csv_syntax',
      message: err.message,
      receivedValue: null
    }));
    return { success: false, errors: csvErrors };
  }

  const errors = [];
  const validatedData = [];

  parsed.data.forEach((row, idx) => {
    const rowNumber = idx + 2; // 1-indexed, header is line 1

    // Specific pre-normalizations for common entities:
    // 1. Flashcards: front & back text objects
    if (row.front !== undefined && typeof row.front === 'string' && schema === FlashcardItemSchema) {
      row = {
        id: row.id || crypto.randomUUID(),
        type: row.type || 'text',
        front: { text: String(row.front || ''), ttsLang: row.tts_lang || 'en-US' },
        back: { text: String(row.back || ''), ttsLang: row.tts_lang || 'en-US' }
      };
    }

    // 2. Timelines: empty end_date to null and stringify numeric dates
    if (schema === TimelineEventSchema || row.start_date !== undefined) {
      if (row.start_date !== undefined && row.start_date !== null && typeof row.start_date !== 'string') {
        row.start_date = String(row.start_date);
      }
      if (row.end_date === '' || row.end_date === undefined || row.end_date === null) {
        row.end_date = null;
      } else if (typeof row.end_date !== 'string') {
        row.end_date = String(row.end_date);
      }
    }
    if (row.color && !row.color.startsWith('#')) {
      row.color = `#${row.color}`;
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
  });

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
