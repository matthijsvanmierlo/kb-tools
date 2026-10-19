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
  getExportPresetTemplate,
  downloadCSVTemplate
} from '../src/core/csv-templates.js';
import { parseCSV, toCSV, downloadCSV, downloadBlob } from '../src/core/csv.js';
import { parseGradesCSV, planGradesImport } from '../src/modules/gradebook/gradebook-csv.js';
import { parseCSVWithValidation, FlashcardItemSchema, TimelineEventSchema } from '../src/core/validator.js';
import { parsePastedRoster } from '../src/core/roster-import.js';
import { vi } from 'vitest';

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

  it('parses CSV with numeric questions and answers without type errors', () => {
    const csvWithNumbers = "Question,Answer\n1984,George Orwell novel\nWhat is 2+2?,4\n100,Boiling point of water";
    const validated = parseCSVWithValidation(csvWithNumbers, FlashcardItemSchema);
    expect(validated.success).toBe(true);
    expect(validated.data.length).toBe(3);
    expect(validated.data[0].front.text).toBe('1984');
    expect(validated.data[0].back.text).toBe('George Orwell novel');
    expect(validated.data[1].front.text).toBe('What is 2+2?');
    expect(validated.data[1].back.text).toBe('4');
    expect(validated.data[2].front.text).toBe('100');
  });

  it('parses headerless spreadsheet paste (raw 2-column data) for flashcards', () => {
    const rawTSVWithoutHeader = "Photosynthesis\tPlant solar energy process\nMitochondria\tPowerhouse of the cell";
    const validated = parseCSVWithValidation(rawTSVWithoutHeader, FlashcardItemSchema);
    expect(validated.success).toBe(true);
    expect(validated.data.length).toBe(2);
    expect(validated.data[0].front.text).toBe('Photosynthesis');
    expect(validated.data[0].back.text).toBe('Plant solar energy process');
    expect(validated.data[1].front.text).toBe('Mitochondria');
  });

  it('parses Dutch educational header aliases (Vraag, Antwoord) for flashcards', () => {
    const dutchCSV = "Vraag;Antwoord\nHoofdstad van Nederland;Amsterdam\nBelangrijkste gas in fotosynthese;Koolstofdioxide";
    const validated = parseCSVWithValidation(dutchCSV, FlashcardItemSchema);
    expect(validated.success).toBe(true);
    expect(validated.data.length).toBe(2);
    expect(validated.data[0].front.text).toBe('Hoofdstad van Nederland');
    expect(validated.data[0].back.text).toBe('Amsterdam');
  });

  it('skips blank empty lines in spreadsheets gracefully', () => {
    const csvWithBlankLines = "Question,Answer\nPhotosynthesis,Process\n\n\nNewton,Physics\n\n";
    const validated = parseCSVWithValidation(csvWithBlankLines, FlashcardItemSchema);
    expect(validated.success).toBe(true);
    expect(validated.data.length).toBe(2);
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

describe('Part 3: Robust CSV & Template Download Engine (Safari / WebKit Non-Blocking)', () => {
  let createdUrls = [];
  let revokedUrls = [];
  let clickedElements = [];

  beforeEach(() => {
    createdUrls = [];
    revokedUrls = [];
    clickedElements = [];

    // Mock URL.createObjectURL and URL.revokeObjectURL
    global.URL.createObjectURL = vi.fn((blob) => {
      const fakeUrl = `blob:http://localhost/${Math.random().toString(36).slice(2)}`;
      createdUrls.push({ url: fakeUrl, blob });
      return fakeUrl;
    });

    global.URL.revokeObjectURL = vi.fn((url) => {
      revokedUrls.push(url);
    });

    // Spy on HTMLAnchorElement.prototype.click
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function() {
      clickedElements.push({
        href: this.href,
        download: this.download,
        rel: this.rel,
        style: {
          position: this.style.position,
          left: this.style.left,
          opacity: this.style.opacity
        },
        isConnected: this.isConnected
      });
    });
  });

  it('downloadCSV formats filenames with .csv and prepends UTF-8 BOM', async () => {
    downloadCSV('students', 'StudentID,Name\nS1,Alice');

    expect(createdUrls.length).toBe(1);
    const { blob } = createdUrls[0];
    expect(blob.type).toBe('text/csv;charset=utf-8');

    // Verify UTF-8 BOM bytes (0xEF, 0xBB, 0xBF)
    const buf = new Uint8Array(await blob.arrayBuffer());
    expect(buf[0]).toBe(0xEF);
    expect(buf[1]).toBe(0xBB);
    expect(buf[2]).toBe(0xBF);

    // Read blob text to verify content
    const blobText = await blob.text();
    expect(blobText).toContain('StudentID,Name\nS1,Alice');

    // Verify click happened on off-screen anchor attached to DOM
    expect(clickedElements.length).toBe(1);
    expect(clickedElements[0].download).toBe('students.csv');
    expect(clickedElements[0].rel).toBe('noopener');
    expect(clickedElements[0].style.position).toBe('fixed');
    expect(clickedElements[0].style.left).toBe('-9999px');
    expect(clickedElements[0].isConnected).toBe(true);
  });

  it('downloadCSV preserves existing .csv extensions and avoids double BOM', async () => {
    const rawCSVWithBom = '\uFEFFStudentID,Name\nS2,Bob';
    downloadCSV('roster_export.csv', rawCSVWithBom);

    expect(createdUrls.length).toBe(1);
    const { blob } = createdUrls[0];
    const buf = new Uint8Array(await blob.arrayBuffer());
    // Single BOM (3 bytes) followed by 'StudentID'
    expect(buf[0]).toBe(0xEF);
    expect(buf[1]).toBe(0xBB);
    expect(buf[2]).toBe(0xBF);
    expect(buf[3]).toBe('S'.charCodeAt(0));
    expect(clickedElements[0].download).toBe('roster_export.csv');
  });

  it('does NOT revoke object URL synchronously, preventing Safari download cancellation', () => {
    vi.useFakeTimers();
    try {
      downloadCSV('test', 'col1\nval1');

      // Crucial: Synchronously right after downloadCSV returns, URL must NOT be revoked yet
      expect(revokedUrls.length).toBe(0);

      // Advance timers by 9 seconds - still deferred
      vi.advanceTimersByTime(9000);
      expect(revokedUrls.length).toBe(0);

      // Advance past 10 seconds - cleanup occurs
      vi.advanceTimersByTime(2000);
      expect(revokedUrls.length).toBe(1);
      expect(revokedUrls[0]).toBe(createdUrls[0].url);
    } finally {
      vi.useRealTimers();
    }
  });

  it('downloadCSVTemplate routes properly through downloadCSV with proper filename', () => {
    downloadCSVTemplate('flashcards_template', FLASHCARDS_CSV_TEMPLATE);

    expect(clickedElements.length).toBe(1);
    expect(clickedElements[0].download).toBe('flashcards_template.csv');
    expect(createdUrls.length).toBe(1);
  });
});
