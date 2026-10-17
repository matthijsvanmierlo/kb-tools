import * as jspdfLib from 'jspdf';
import * as autotableLib from 'jspdf-autotable';
import jszipLib from 'jszip';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { GradebookMathEngine } from './engine-calc.js';
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

    const overallPct = GradebookMathEngine.computeTraditionalWeighted(studentRecords, assignments, course.categories || []);
    const letter = GradebookMathEngine.percentageToLetter(overallPct);

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
  static async createStudentShareLink(student, course, assignments, gradesMap) {
    // Isolate student data
    const isolatedGrades = {};
    assignments.forEach(a => {
      const key = `${student.student_id}+${a.id}`;
      const rec = gradesMap.get ? gradesMap.get(key) : gradesMap[key];
      if (rec) isolatedGrades[a.id] = rec;
    });

    const isolatedPayload = {
      student: {
        student_id: student.student_id,
        full_name: student.full_name,
        email: student.email
      },
      course: {
        id: course.id,
        name: course.name,
        academic_year: course.academic_year,
        categories: course.categories,
        terms: course.terms
      },
      assignments: assignments.map(a => ({
        id: a.id,
        title: a.title,
        max_score: a.max_score,
        category_id: a.category_id,
        due_date: a.due_date
      })),
      grades: isolatedGrades
    };

    // Encrypted with the student's own Student ID
    return await CryptoShareEngine.createSharePayload('student_grade_report', isolatedPayload, student.student_id);
  }
}

export default GradebookReportGenerator;
