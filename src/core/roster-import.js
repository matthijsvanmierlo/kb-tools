import { ROSTER_HEADER_ALIASES, RosterRowSchema } from './validator.js';
import { splitName, joinName } from './names.js';
import { toCSV, parseCSV, suggestDelimiter } from './csv.js';
import papaLib from 'papaparse';

const Papa = papaLib.parse ? papaLib : (papaLib.default || papaLib);

/**
 * Normalise a header string for alias matching.
 * Lowercase, strips whitespace, underscores, hyphens, and dots.
 * @param {string} header
 * @returns {string}
 */
function cleanHeader(header) {
  return String(header || '').toLowerCase().replace(/[\s_\-.]+/g, '');
}

/**
 * Auto-detect column mapping from CSV/TSV headers using ROSTER_HEADER_ALIASES.
 * @param {string[]} fields - Array of header strings from the import file
 * @returns {{ mapping: { student_id: string|null, full_name: string|null, given_name: string|null, family_name: string|null, email: string|null, access_code: string|null, notes: string|null }, confidence: number }}
 */
export function detectColumns(fields = []) {
  const mapping = {
    student_id: null,
    full_name: null,
    given_name: null,
    family_name: null,
    email: null,
    access_code: null,
    notes: null
  };

  if (!Array.isArray(fields) || fields.length === 0) {
    return { mapping, confidence: 0 };
  }

  // Target precedence ranking for conflicts (e.g. 'Student ID' > 'ID')
  const fieldPriority = {
    student_id: ['studentid', 'leerlingnummer', 'sisid', 'sisuserid', 'identifier', 'id'],
    full_name: ['fullname', 'studentname', 'naam', 'student', 'name'],
    given_name: ['firstname', 'voornaam', 'givenname', 'first'],
    family_name: ['lastname', 'achternaam', 'surname', 'familyname', 'last'],
    email: ['email', 'emailaddress', 'mail', 'studentemail'],
    access_code: ['accesscode', 'toegangscode', 'code'],
    notes: ['notes', 'opmerkingen', 'comments', 'note']
  };

  for (const rawField of fields) {
    const cleaned = cleanHeader(rawField);
    const target = ROSTER_HEADER_ALIASES[cleaned];
    if (target && target in mapping) {
      if (!mapping[target]) {
        mapping[target] = rawField;
      } else {
        // Check if rawField has higher priority than existing mapping
        const priorities = fieldPriority[target] || [];
        const existingClean = cleanHeader(mapping[target]);
        const currentRank = priorities.indexOf(cleaned);
        const existingRank = priorities.indexOf(existingClean);
        if (currentRank !== -1 && (existingRank === -1 || currentRank < existingRank)) {
          mapping[target] = rawField;
        }
      }
    }
  }

  // Calculate confidence score (0 to 1)
  let score = 0;
  if (mapping.student_id) score += 0.45;
  if (mapping.full_name) {
    score += 0.35;
  } else if (mapping.given_name && mapping.family_name) {
    score += 0.35;
  } else if (mapping.given_name || mapping.family_name) {
    score += 0.2;
  }
  if (mapping.email) score += 0.1;
  if (mapping.access_code || mapping.notes) score += 0.1;

  const confidence = Math.min(1, Math.round(score * 100) / 100);

  return { mapping, confidence };
}

/**
 * Normalise and validate rows according to column mapping.
 * Performs name splitting/joining, ID trimming, and Zod validation.
 * @param {Array<object>} rows - Array of row objects from CSV/pasted data
 * @param {object} mapping - Map of target fields to row keys
 * @returns {Array<object|{ rowNumber: number, errors: string[] }>}
 */
export function normalizeRows(rows = [], mapping = {}) {
  const result = [];

  rows.forEach((row, idx) => {
    const rowNumber = idx + 1;
    if (!row || typeof row !== 'object') {
      result.push({ rowNumber, errors: ['Invalid row data'] });
      return;
    }

    // Extract raw values based on mapping
    const getVal = (target) => {
      const colName = mapping[target];
      if (!colName) return undefined;
      const v = row[colName];
      return v !== undefined && v !== null ? String(v).trim() : undefined;
    };

    let student_id = getVal('student_id');
    // If student_id is unmapped or blank, check if email-as-id was opted into
    if (!student_id && mapping.student_id === '__email__') {
      student_id = getVal('email');
    }

    let full_name = getVal('full_name');
    let given_name = getVal('given_name');
    let family_name = getVal('family_name');
    const email = getVal('email');
    const access_code = getVal('access_code');
    const notes = getVal('notes');

    // Handle name split and join
    if (full_name && (!given_name || !family_name)) {
      const split = splitName(full_name);
      if (!given_name) given_name = split.given || undefined;
      if (!family_name) family_name = split.family || undefined;
      if (full_name.includes(',')) {
        full_name = joinName(given_name, family_name);
      }
    } else if (!full_name && (given_name || family_name)) {
      full_name = joinName(given_name || '', family_name || '') || undefined;
    }

    const candidate = {
      student_id: student_id || '',
      full_name: full_name || '',
      given_name: given_name || undefined,
      family_name: family_name || undefined,
      email: email || undefined,
      access_code: access_code || undefined,
      notes: notes || undefined
    };

    const parsed = RosterRowSchema.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues || parsed.error.errors || [];
      result.push({
        rowNumber,
        errors: issues.map(e => e.message)
      });
    } else {
      result.push({
        student_id: parsed.data.student_id,
        full_name: parsed.data.full_name || '',
        given_name: parsed.data.given_name || '',
        family_name: parsed.data.family_name || '',
        email: parsed.data.email || undefined,
        access_code: parsed.data.access_code || undefined,
        notes: parsed.data.notes || undefined
      });
    }
  });

  return result;
}

/**
 * Plan merge of incoming rows into existing course roster.
 * Key: trim(student_id).toUpperCase().
 * Never overwrites access_code unless explicitly allowed and incoming row has a value.
 * @param {Array<object>} existingStudents - Array of existing student records in course
 * @param {Array<object>} incomingRows - Array of normalized rows from normalizeRows
 * @param {object} [opts]
 * @param {boolean} [opts.updateExisting=true]
 * @param {boolean} [opts.allowAccessCodeOverwrite=false]
 * @returns {{ add: object[], update: Array<{ existing: object, incoming: object, changes: Array<{ field: string, from: any, to: any }> }>, unchanged: object[], conflicts: Array<{ row: any, reason: string }>, duplicatesInFile: Array<{ student_id: string, row: any }> }}
 */
export function planMerge(existingStudents = [], incomingRows = [], opts = {}) {
  const { updateExisting = true, allowAccessCodeOverwrite = false } = opts;

  const add = [];
  const update = [];
  const unchanged = [];
  const conflicts = [];
  const duplicatesInFile = [];

  // Index existing students by uppercase trimmed student_id
  const existingMap = new Map();
  for (const s of existingStudents) {
    if (s && s.student_id) {
      existingMap.set(String(s.student_id).trim().toUpperCase(), s);
    }
  }

  const seenInFile = new Set();

  for (const row of incomingRows) {
    if (!row || row.errors || !row.student_id) {
      conflicts.push({
        row,
        reason: (row && row.errors) ? row.errors.join('; ') : 'Missing student ID'
      });
      continue;
    }

    const key = String(row.student_id).trim().toUpperCase();

    if (seenInFile.has(key)) {
      duplicatesInFile.push({ student_id: row.student_id, row });
      continue;
    }
    seenInFile.add(key);

    const existing = existingMap.get(key);
    if (!existing) {
      add.push(row);
    } else {
      if (!updateExisting) {
        unchanged.push(existing);
      } else {
        const changes = [];
        const compareFields = ['full_name', 'given_name', 'family_name', 'email', 'notes'];

        for (const field of compareFields) {
          const incVal = row[field] ? String(row[field]).trim() : '';
          const exVal = existing[field] ? String(existing[field]).trim() : '';
          if (incVal && incVal !== exVal) {
            changes.push({ field, from: existing[field] || null, to: row[field] });
          }
        }

        // Access code update check
        if (allowAccessCodeOverwrite && row.access_code) {
          const incCode = String(row.access_code).trim();
          const exCode = String(existing.access_code || '').trim();
          if (incCode && incCode !== exCode) {
            changes.push({ field: 'access_code', from: existing.access_code || null, to: row.access_code });
          }
        }

        if (changes.length > 0) {
          update.push({ existing, incoming: row, changes });
        } else {
          unchanged.push(existing);
        }
      }
    }
  }

  return { add, update, unchanged, conflicts, duplicatesInFile };
}

/**
 * Parse pasted roster text: accepts TSV (spreadsheet paste), CSV, or "Name <email>" / "Name, ID" lines.
 * @param {string} text
 * @returns {{ fields: string[], rows: Array<object> }}
 */
export function parsePastedRoster(text = '') {
  if (!text || typeof text !== 'string') {
    return { fields: [], rows: [] };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { fields: [], rows: [] };
  }

  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { fields: [], rows: [] };
  }

  // Pattern 1: Every line matches "Name <email@...>"
  const isAngleBracketEmail = lines.every(l => /^[^<>\t]+<[^@<>]+@[^@<>]+>$/.test(l));
  if (isAngleBracketEmail) {
    const fields = ['full_name', 'email'];
    const rows = lines.map(line => {
      const match = line.match(/^([^<]+)<([^>]+)>/);
      return {
        full_name: match ? match[1].trim() : '',
        email: match ? match[2].trim() : ''
      };
    });
    return { fields, rows };
  }

  // Pattern 2: Delimited data (TSV, CSV, etc.)
  const parsed = Papa.parse(trimmed, {
    header: false,
    dynamicTyping: false,
    skipEmptyLines: 'greedy'
  });

  const matrix = parsed.data || [];
  if (matrix.length === 0) {
    return { fields: [], rows: [] };
  }

  const firstRow = matrix[0] || [];

  // Determine if first row is a header row by checking for alias matches
  const matchCount = firstRow.filter(cell => {
    const clean = cleanHeader(cell);
    return Boolean(ROSTER_HEADER_ALIASES[clean]);
  }).length;

  const isHeader = matchCount >= 1 && (firstRow.length <= 2 || matchCount >= 2);

  if (isHeader) {
    const fields = firstRow.map(c => String(c || '').trim());
    const dataRows = matrix.slice(1);
    const rows = dataRows.map(r => {
      const rowObj = {};
      fields.forEach((f, idx) => {
        rowObj[f] = r[idx] !== undefined && r[idx] !== null ? String(r[idx]).trim() : '';
      });
      return rowObj;
    });
    return { fields, rows };
  }

  // If first row is data, construct generic column names
  const colCount = Math.max(...matrix.map(r => r.length));
  const fields = [];

  for (let i = 0; i < colCount; i++) {
    fields.push(`Column ${i + 1}`);
  }

  const rows = matrix.map(r => {
    const rowObj = {};
    fields.forEach((f, idx) => {
      rowObj[f] = r[idx] !== undefined && r[idx] !== null ? String(r[idx]).trim() : '';
    });
    return rowObj;
  });

  return { fields, rows };
}

/**
 * Apply grading template to a course object (pure, non-mutating)
 * @param {object} course
 * @param {'points_two_categories'|'points_single_category'|'sbg'|'copy'} templateKey
 * @param {object} [sourceCourse] - Required if templateKey is 'copy'
 * @returns {object} Cloned course with updated categories, terms, and grading_scale
 */
export function applyGradingTemplate(course, templateKey, sourceCourse = null) {
  const result = JSON.parse(JSON.stringify(course || {}));

  const genId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'cat_' + Math.random().toString(36).slice(2, 9));

  switch (templateKey) {
    case 'points_two_categories':
    case 'traditional': {
      result.grading_scale = 'traditional';
      result.categories = [
        {
          id: genId(),
          name: 'Assessments',
          weight_pct: 60,
          drop_lowest: 0,
          policy: { missing_floor_pct: 50, late_mode: 'none', late_deduct_pct: 0, late_daily_pct: 0, max_late_cap_pct: 50, minimum_grade_pct: 0 }
        },
        {
          id: genId(),
          name: 'Classwork & Homework',
          weight_pct: 40,
          drop_lowest: 1,
          policy: { missing_floor_pct: 50, late_mode: 'none', late_deduct_pct: 0, late_daily_pct: 0, max_late_cap_pct: 50, minimum_grade_pct: 0 }
        }
      ];
      break;
    }
    case 'points_single_category': {
      result.grading_scale = 'traditional';
      result.categories = [
        {
          id: genId(),
          name: 'All Work',
          weight_pct: 100,
          drop_lowest: 0,
          policy: { missing_floor_pct: 0, late_mode: 'none', late_deduct_pct: 0, late_daily_pct: 0, max_late_cap_pct: 50, minimum_grade_pct: 0 }
        }
      ];
      break;
    }
    case 'sbg': {
      result.grading_scale = 'sbg';
      result.categories = [
        {
          id: genId(),
          name: 'Standards Evidence',
          weight_pct: 100,
          drop_lowest: 0,
          policy: { missing_floor_pct: 0, late_mode: 'none', late_deduct_pct: 0, late_daily_pct: 0, max_late_cap_pct: 50, minimum_grade_pct: 0 }
        }
      ];
      break;
    }
    case 'copy': {
      if (sourceCourse) {
        result.grading_scale = sourceCourse.grading_scale || 'traditional';
        result.categories = JSON.parse(JSON.stringify(sourceCourse.categories || []));
        result.terms = JSON.parse(JSON.stringify(sourceCourse.terms || []));
        if (sourceCourse.letter_scale) result.letter_scale = JSON.parse(JSON.stringify(sourceCourse.letter_scale));
        if (sourceCourse.sbg_config) result.sbg_config = JSON.parse(JSON.stringify(sourceCourse.sbg_config));
      }
      break;
    }
    default:
      break;
  }

  return result;
}

/**
 * Generate standard Roster CSV string per Appendix A
 * Columns: StudentID, FullName, FirstName, LastName, Email, Class, Section, AcademicYear, HasAccessCode, [AccessCode], Notes
 * @param {Array<object>} students
 * @param {object} course
 * @param {object} [opts]
 * @param {boolean} [opts.includeAccessCode=false]
 * @param {string} [opts.delimiter=',']
 * @returns {string}
 */
export function exportRosterCSV(students = [], course = {}, opts = {}) {
  const { includeAccessCode = false, delimiter = suggestDelimiter() } = opts;

  const rows = students.map(s => {
    const split = splitName(s.full_name || '');
    const firstName = s.given_name || split.given_name || '';
    const lastName = s.family_name || split.family_name || '';

    const row = {
      StudentID: s.student_id || '',
      FullName: s.full_name || '',
      FirstName: firstName,
      LastName: lastName,
      Email: s.email || '',
      Class: course.name || '',
      Section: course.section || '',
      AcademicYear: course.academic_year || '',
      HasAccessCode: s.access_code ? 'Yes' : 'No',
      Notes: s.notes || ''
    };

    if (includeAccessCode) {
      row.AccessCode = s.access_code || '';
    }

    return row;
  });

  const columns = [
    'StudentID',
    'FullName',
    'FirstName',
    'LastName',
    'Email',
    'Class',
    'Section',
    'AcademicYear',
    'HasAccessCode'
  ];

  if (includeAccessCode) {
    columns.push('AccessCode');
  }

  columns.push('Notes');

  return toCSV(rows, columns, { delimiter, bom: true });
}
