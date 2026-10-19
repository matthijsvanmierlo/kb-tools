import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROSTER_CSV_TEMPLATE,
  FLASHCARDS_CSV_TEMPLATE,
  TIMELINE_CSV_TEMPLATE,
  STANDARDS_CSV_TEMPLATE,
  getGradesCSVTemplate,
  getExportPresetTemplate
} from '../src/core/csv-templates.js';
import { parseCSV, toCSV } from '../src/core/csv.js';
import { parseGradesCSV, planGradesImport } from '../src/modules/gradebook/gradebook-csv.js';
import { parseCSVWithValidation, FlashcardItemSchema, TimelineEventSchema } from '../src/core/validator.js';
import { parsePastedRoster } from '../src/core/roster-import.js';

describe('Part 1: MacBook Air Navigation Bar & Backup Button Refinement', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'css/app.css'), 'utf8');
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

  it('contains the backup storage menu in the application header', () => {
    expect(html).toContain('class="kb-storage-menu"');
    expect(html).toContain('title="Backup &amp; storage"');
  });

  it('defines responsive navbar breakpoint covering MacBook Air resolution (up to 1535.98px)', () => {
    // MacBook Air default is 1440px or 1366px. The breakpoint must cover up to 1535.98px
    // so inactive labels collapse to icons with active label showing, avoiding any overflow.
    expect(css).toMatch(/@media\s*\(min-width:\s*768px\)\s*and\s*\(max-width:\s*1535\.98px\)/);
    expect(css).toContain('.kb-nav-link.kb-nav-active span { display: inline; }');
  });

  it('sets kb-header-inner max-width to allow comfortable wide-screen breathing room without cutoff', () => {
    expect(css).toContain('max-width: min(100%, 96rem);');
  });

  it('prevents kb-storage-menu (backup button) from shrinking off-screen', () => {
    expect(css).toContain('.kb-storage-menu {\n  flex-shrink: 0;\n}');
  });
});

describe('Part 2A: CSV Templates for Imports and Exports', () => {
  it('provides a valid ROSTER_CSV_TEMPLATE with standard column headers', () => {
    const parsed = parseCSV(ROSTER_CSV_TEMPLATE);
    expect(parsed.fields).toEqual(['StudentID', 'FirstName', 'LastName', 'FullName', 'Email', 'Notes']);
    expect(parsed.rows.length).toBeGreaterThanOrEqual(2);
    expect(parsed.rows[0].StudentID).toBe('S101');
    expect(parsed.rows[0].FullName).toBe('Emma Watson');
  });

  it('provides a valid FLASHCARDS_CSV_TEMPLATE with Question and Answer columns', () => {
    const parsed = parseCSV(FLASHCARDS_CSV_TEMPLATE);
    expect(parsed.fields).toEqual(['Question', 'Answer']);
    expect(parsed.rows.length).toBeGreaterThanOrEqual(2);
    expect(parsed.rows[0].Question).toBe('Photosynthesis');

    // Validates against FlashcardItemSchema
    const validated = parseCSVWithValidation(FLASHCARDS_CSV_TEMPLATE, FlashcardItemSchema);
    expect(validated.success).toBe(true);
    expect(validated.data.length).toBe(parsed.rows.length);
  });

  it('provides a valid TIMELINE_CSV_TEMPLATE with Title, Start Date, Category, etc.', () => {
    const parsed = parseCSV(TIMELINE_CSV_TEMPLATE);
    expect(parsed.fields).toEqual(['Title', 'Start Date', 'End Date', 'Category', 'Description', 'Color', 'Citations']);
    expect(parsed.rows.length).toBeGreaterThanOrEqual(2);

    // Validates against TimelineEventSchema
    const validated = parseCSVWithValidation(TIMELINE_CSV_TEMPLATE, TimelineEventSchema);
    expect(validated.success).toBe(true);
    expect(validated.data.length).toBe(parsed.rows.length);
  });

  it('provides a valid STANDARDS_CSV_TEMPLATE with Code and Description columns', () => {
    const parsed = parseCSV(STANDARDS_CSV_TEMPLATE);
    expect(parsed.fields).toEqual(['Code', 'Description']);
    expect(parsed.rows.length).toBeGreaterThanOrEqual(2);
    expect(parsed.rows[0].Code).toBe('HS-PS1-1');
  });

  it('dynamically generates grades CSV template matching course assignments', () => {
    const course = { id: 'c1', name: 'AP Chemistry' };
    const assignments = [
      { id: 'a1', title: 'Stoichiometry Lab' },
      { id: 'a2', title: 'Equilibrium Exam' }
    ];
    const students = [
      { student_id: 'S201', full_name: 'Niels Bohr' },
      { student_id: 'S202', full_name: 'Lise Meitner' }
    ];

    const template = getGradesCSVTemplate(course, assignments, students);
    const parsed = parseCSV(template);

    expect(parsed.fields).toEqual(['StudentID', 'StudentName', 'Stoichiometry Lab', 'Equilibrium Exam']);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0].StudentID).toBe('S201');
    expect(parsed.rows[0].StudentName).toBe('Niels Bohr');
    expect(parsed.rows[0]['Stoichiometry Lab']).toBeDefined();
  });

  it('generates fallback grades CSV template when no assignments exist yet', () => {
    const template = getGradesCSVTemplate({}, [], []);
    const parsed = parseCSV(template);

    expect(parsed.fields).toContain('StudentID');
    expect(parsed.fields).toContain('StudentName');
    expect(parsed.fields).toContain('Quiz 1');
    expect(parsed.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('generates CSV template for ExportDialog presets', () => {
    const mailMergePreset = { id: 'mail_merge', label: 'Mail-Merge' };
    const template = getExportPresetTemplate(mailMergePreset);
    const parsed = parseCSV(template);

    expect(parsed.fields).toContain('StudentID');
    expect(parsed.fields).toContain('FullName');
    expect(parsed.fields).toContain('OverallScore');
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0].StudentID).toBe('S101');
  });
});

describe('Part 2B: Copy-Pasting from Spreadsheets (TSV/CSV) & File Imports', () => {
  it('parses pasted tab-separated values from Google Sheets / Excel for flashcards', () => {
    // When a user copies 2 columns from Excel/Google Sheets:
    const tsvFromSheets = "Question\tAnswer\nCell Biology\tStudy of cell structure and function\nThermodynamics\tBranch of physics dealing with heat and work";

    const validated = parseCSVWithValidation(tsvFromSheets, FlashcardItemSchema);
    expect(validated.success).toBe(true);
    expect(validated.data.length).toBe(2);
    expect(validated.data[0].front.text).toBe('Cell Biology');
    expect(validated.data[0].back.text).toBe('Study of cell structure and function');
    expect(validated.data[1].front.text).toBe('Thermodynamics');
  });

  it('parses pasted tab-separated values from Google Sheets / Excel for timeline events', () => {
    const tsvFromSheets = "Title\tStart Date\tEnd Date\tCategory\tDescription\nMars Rover Landing\t2021-02-18\t\tSpace\tPerseverance touches down in Jezero crater";

    const validated = parseCSVWithValidation(tsvFromSheets, TimelineEventSchema);
    expect(validated.success).toBe(true);
    expect(validated.data.length).toBe(1);
    expect(validated.data[0].title).toBe('Mars Rover Landing');
    expect(validated.data[0].start_date).toBe('2021-02-18');
    expect(validated.data[0].category).toBe('Space');
  });

  it('parses pasted spreadsheet grades (TSV) into Gradebook changes plan', () => {
    const course = { id: 'c1', name: 'AP Physics' };
    const students = [
      { student_id: 'S001', full_name: 'Isaac Newton' },
      { student_id: 'S002', full_name: 'Albert Einstein' }
    ];
    const assignments = [
      { id: 'asgn-1', title: 'Exam 1', max_score: 100 }
    ];
    const gradesMap = new Map([
      ['S001+asgn-1', { id: 'g1', student_id: 'S001', assignment_id: 'asgn-1', raw_score: 90, status: 'submitted' }]
    ]);

    // Teacher copies grades from Google Sheets:
    const pastedGradesTSV = "StudentID\tStudentName\tExam 1\nS001\tIsaac Newton\t98\nS002\tAlbert Einstein\t92";

    const parsed = parseGradesCSV(pastedGradesTSV);
    expect(parsed.students.length).toBe(2);

    const plan = planGradesImport({
      parsed,
      course,
      students,
      assignments,
      gradesMap
    });

    expect(plan.matchedColumns.length).toBe(1);
    expect(plan.changes.length).toBe(2);
    // S001 updated from 90 to 98
    const s1 = plan.changes.find(c => c.student_id === 'S001');
    expect(s1.before.raw_score).toBe(90);
    expect(s1.after.raw_score).toBe(98);
    // S002 new score 92
    const s2 = plan.changes.find(c => c.student_id === 'S002');
    expect(s2.after.raw_score).toBe(92);
  });

  it('parses pasted roster text from spreadsheet using parsePastedRoster', () => {
    const pastedRosterTSV = "StudentID\tFull Name\tEmail\nS101\tAlan Turing\talan@cambridge.ac.uk\nS102\tAda Lovelace\tada@lovelace.org";

    const res = parsePastedRoster(pastedRosterTSV);
    expect(res.fields).toEqual(['StudentID', 'Full Name', 'Email']);
    expect(res.rows.length).toBe(2);
    expect(res.rows[0].StudentID).toBe('S101');
    expect(res.rows[0]['Full Name']).toBe('Alan Turing');
    expect(res.rows[1].StudentID).toBe('S102');
    expect(res.rows[1]['Full Name']).toBe('Ada Lovelace');
  });
});
