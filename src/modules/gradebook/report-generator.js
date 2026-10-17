import * as jspdfLib from 'jspdf';
import * as autotableLib from 'jspdf-autotable';
import jszipLib from 'jszip';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { computeStudentSummary } from './aggregates.js';
import { getStandards, getSbgConfig, getLetterScale, levelInfo } from './grading-scales.js';
import { RubricScorer } from './rubric-builder.js';
import { AccessCodes } from '../../core/access-codes.js';
import { toast } from '../../utils/toast.js';

const jsPDFClass = jspdfLib.jsPDF || jspdfLib.default;
const autoTable = autotableLib.autoTable || autotableLib.default;
const JSZip = jszipLib.default || jszipLib;

/**
 * Gradebook Report Generator (KB-GRAD-004)
 * Generates single-student PDF reports, batch roster ZIP packages,
 * and zero-server FERPA-isolated encrypted student progress URLs.
 */
export class GradebookReportGenerator {
  /**
   * Generate an individual student PDF report
   * @param {object} student - { student_id, full_name, email }
   * @param {object} course - { name, academic_year, categories, terms }
   * @param {any[]} assignments
   * @param {Map<string, object>} gradesMap - key: `${student_id}+${assignment_id}`
   * @param {object} [options]
   * @returns {jsPDF}
   */
  static generateStudentPDF(student, course, assignments, gradesMap, options = {}) {
    const doc = new jsPDFClass({ orientation: 'portrait', unit: 'pt', format: 'letter' });

    // 1. Header Banner
    doc.setFillColor(30, 41, 59); // Slate 800
    doc.rect(0, 0, 612, 70, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18);
    doc.text('Student Progress Report', 40, 42);

    // Student & Course Meta
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(11);
    doc.text(`Student: ${student.full_name} (ID: ${student.student_id})`, 40, 100);
    doc.text(`Course: ${course.name} (${course.academic_year || '2026-2027'})`, 40, 116);
    doc.text(`Generated: ${new Date().toISOString().split('T')[0]}`, 40, 132);

    // Calculate overall grade
    const studentRecords = new Map();
    assignments.forEach(a => {
      const rec = gradesMap.get ? gradesMap.get(`${student.student_id}+${a.id}`) : gradesMap[`${student.student_id}+${a.id}`];
      if (rec) studentRecords.set(a.id, rec);
    });

    const summaryMap = gradesMap.get ? gradesMap : new Map(Object.entries(gradesMap));
    const summary = computeStudentSummary(student, course, assignments, summaryMap);
    const overallPct = summary.score;
    const letter = summary.letter;

    // Grade Badge box
    doc.setFillColor(239, 246, 255); // Blue 50
    doc.roundedRect(440, 85, 132, 54, 6, 6, 'F');
    doc.setTextColor(37, 99, 235);
    doc.setFontSize(10);
    doc.text('CUMULATIVE GRADE', 450, 102);
    doc.setFontSize(16);
    doc.text(`${overallPct !== null ? `${overallPct}%` : '—'} (${letter})`, 450, 126);

    let startY = 160;

    // 2. Missing Assignments Alert Box
    const missingAssignments = assignments.filter(a => {
      const rec = gradesMap.get ? gradesMap.get(`${student.student_id}+${a.id}`) : gradesMap[`${student.student_id}+${a.id}`];
      return rec && rec.status === 'missing';
    });

    if (missingAssignments.length > 0) {
      doc.setDrawColor(239, 68, 68); // Red 500
      doc.setFillColor(254, 242, 242); // Red 50
      doc.roundedRect(40, startY, 532, 34 + missingAssignments.length * 14, 4, 4, 'FD');

      doc.setTextColor(185, 28, 28);
      doc.setFontSize(10);
      doc.text(`! MISSING WORK ALERT: ${missingAssignments.length} assignment(s) currently marked missing`, 50, startY + 18);

      missingAssignments.forEach((ma, idx) => {
        doc.setFontSize(9);
        doc.text(`• ${ma.title} (Due: ${ma.due_date || 'N/A'}, Max: ${ma.max_score}pts)`, 60, startY + 34 + idx * 14);
      });

      startY += 48 + missingAssignments.length * 14;
    }

    // 3. Detailed Grades Table
    const catMap = new Map((course.categories || []).map(c => [c.id, c.name]));
    const rows = assignments.map(a => {
      const rec = gradesMap.get ? gradesMap.get(`${student.student_id}+${a.id}`) : gradesMap[`${student.student_id}+${a.id}`];
      const status = rec ? rec.status.toUpperCase() : 'NOT SUBMITTED';
      const scoreStr = rec && rec.raw_score !== null ? `${rec.raw_score} / ${a.max_score}` : `— / ${a.max_score}`;
      const feedback = rec && rec.feedback ? rec.feedback : '';

      return [
        a.title,
        catMap.get(a.category_id) || 'General',
        a.due_date || '—',
        status,
        scoreStr,
        feedback
      ];
    });

    if (typeof doc.autoTable === 'function') {
      doc.autoTable({
        startY,
        head: [['Assignment', 'Category', 'Due Date', 'Status', 'Score', 'Feedback / Notes']],
        body: rows,
        theme: 'grid',
        headStyles: { fillColor: [30, 41, 59] },
        styles: { fontSize: 8, cellPadding: 4 },
        pageBreak: 'auto'
      });
    } else if (typeof autoTable === 'function') {
      autoTable(doc, {
        startY,
        head: [['Assignment', 'Category', 'Due Date', 'Status', 'Score', 'Feedback / Notes']],
        body: rows,
        theme: 'grid',
        headStyles: { fillColor: [30, 41, 59] },
        styles: { fontSize: 8, cellPadding: 4 },
        pageBreak: 'auto'
      });
    }

    return doc;
  }

  /**
   * Generate batch .zip containing individual PDFs for every student in the roster
   * @param {any[]} students
   * @param {object} course
   * @param {any[]} assignments
   * @param {Map<string, object>} gradesMap
   * @returns {Promise<Blob>} ZIP Blob
   */
  static async generateBatchZip(students, course, assignments, gradesMap) {
    const zip = new JSZip();

    for (const student of students) {
      const doc = this.generateStudentPDF(student, course, assignments, gradesMap);
      const pdfBuffer = doc.output('arraybuffer');
      const filename = `${student.student_id}_${student.full_name.replace(/\s+/g, '_')}_Report.pdf`;
      zip.file(filename, pdfBuffer);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    return zipBlob;
  }

  /**
   * Trigger download of batch roster ZIP archive
   */
  static async downloadBatchZip(students, course, assignments, gradesMap) {
    if (typeof document === 'undefined') return;
    toast.info(`Generating ${students.length} report PDFs...`);

    const blob = await this.generateBatchZip(students, course, assignments, gradesMap);
    const filename = `${course.name.replace(/\s+/g, '_')}_Grade_Reports_Batch.zip`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 100);

    toast.success('Batch ZIP downloaded!');
  }

  /**
   * Create zero-server FERPA-isolated student URL encrypted with student ID
   * Strips all other students' records to guarantee 100% data privacy.
   * @param {object} student
   * @param {object} course
   * @param {any[]} assignments
   * @param {Map<string, object>} gradesMap
   * @returns {Promise<{ url: string, exceedsUrlLimit: boolean }>}
   */
  static async createStudentShareLink(student, course, assignments, gradesMap, rubrics = []) {
    const payload = this.buildStudentReportPayload(student, course, assignments, gradesMap, rubrics);
    const result = await CryptoShareEngine.createSharePayload('student_grade_report', payload, AccessCodes.reportPassphrase(student));
    return { ...result, usesAccessCode: !AccessCodes.isWeak(student) };
  }

  /**
   * Build the isolated, read-only report a student receives. Contains only this student's data:
   * scores, statuses, feedback, rubric results and comments, and standards mastery.
   */
  static buildStudentReportPayload(student, course, assignments, gradesMap, rubrics = []) {
    const map = gradesMap.get ? gradesMap : new Map(Object.entries(gradesMap));
    const summary = computeStudentSummary(student, course, assignments, map);
    const standards = getStandards(course);
    const codeOf = (id) => standards.find(s => s.id === id)?.code || id;

    const ordered = [...assignments].sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    const items = ordered.map(a => {
      const rec = map.get(`${student.student_id}+${a.id}`) || null;
      const category = (course.categories || []).find(c => c.id === a.category_id);
      const rubric = a.rubric_id ? rubrics.find(r => r.id === a.rubric_id) : null;
      let rubricResult = null;
      if (rubric && rec?.rubric_eval && Object.keys(rec.rubric_eval).length) {
        const score = RubricScorer.calculateScore(rubric, rec.rubric_eval);
        rubricResult = {
          title: rubric.title,
          earned: score.totalEarned,
          possible: score.totalPossible,
          criteria: (rubric.criteria || []).map(c => {
            const tier = (rubric.tiers || []).find(t => t.id === rec.rubric_eval[c.id]);
            const cell = tier ? c.cells?.[tier.id] : null;
            return {
              name: c.name,
              level: tier?.label || null,
              points: cell ? (cell.points ?? tier?.default_points ?? 0) : null,
              descriptor: cell?.descriptor || '',
              comment: rec.rubric_comments?.[c.id] || ''
            };
          })
        };
      }
      return {
        title: a.title,
        category: category?.name || '',
        due_date: a.due_date || '',
        scoring: a.scoring || 'points',
        max_score: a.max_score,
        standards: (a.standard_ids || []).map(codeOf),
        grade: rec ? {
          raw_score: rec.raw_score ?? null,
          status: rec.status || 'submitted',
          days_late: rec.days_late || null,
          feedback: rec.feedback || '',
          standard_scores: Object.fromEntries(Object.entries(rec.standard_scores || {}).map(([id, v]) => [codeOf(id), v])),
          standard_comments: Object.fromEntries(Object.entries(rec.standard_comments || {}).map(([id, v]) => [codeOf(id), v]))
        } : null,
        rubric: rubricResult
      };
    });

    const sbg = getSbgConfig(course);
    return {
      version: 2,
      generated_at: new Date().toISOString(),
      student: { student_id: student.student_id, full_name: student.full_name },
      course: {
        name: course.name,
        section: course.section || '',
        academic_year: course.academic_year || '',
        mode: summary.mode,
        letter_bands: getLetterScale(course).bands,
        levels: sbg.levels
      },
      summary: { score: summary.score, letter: summary.letter, mastery: summary.mastery },
      standards: summary.standards
        ? standards
          .map(s => {
            const b = summary.standards.get(s.id);
            const lvl = b?.mastery != null ? levelInfo(course, b.mastery) : null;
            return {
              code: s.code,
              description: s.description,
              mastery: b?.mastery ?? null,
              level_label: lvl?.label || null,
              color: lvl?.color || null,
              evidence: (b?.evidence || []).map(e => ({ title: e.title, level: e.level, date: e.date }))
            };
          })
        : [],
      assignments: items
    };
  }
}

export default GradebookReportGenerator;
