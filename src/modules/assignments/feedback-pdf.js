/**
 * Assignment Feedback PDF Generator & Batch Zipper (KB-ASSIGN-010)
 * Generates student feedback PDFs using jsPDF and batches them into a ZIP archive using JSZip.
 */

import * as jspdfLib from 'jspdf';
import * as autotableLib from 'jspdf-autotable';
import jszipLib from 'jszip';
import { finalScore, totalPoints, answerToText, describeCorrectAnswer } from './grading.js';

const jsPDFClass = jspdfLib.jsPDF || jspdfLib.default;
const autoTable = autotableLib.autoTable || autotableLib.default;
const JSZip = jszipLib.default || jszipLib;

/**
 * Generate a single student feedback PDF document.
 *
 * @param {object} params
 * @param {object} params.assignment
 * @param {object} params.submission
 * @param {object} [params.student]
 * @param {object} [params.course]
 * @returns {jsPDF}
 */
export function generateSubmissionPDF({ assignment, submission, student, course }) {
  const doc = new jsPDFClass({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const allowAnswers = !!assignment?.settings?.show_correct_answers;

  const studentName = student?.full_name || submission?.student_name || 'Student';
  const studentId = student?.student_id || submission?.student_id || '';
  const courseName = course?.name || 'Class';
  const courseSection = course?.section ? ` (${course.section})` : '';

  // 1. Header Banner
  doc.setFillColor(30, 41, 59); // Slate 800
  doc.rect(0, 0, 612, 70, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.text('Assignment Feedback Report', 40, 35);
  doc.setFontSize(11);
  doc.text(`${assignment?.title || 'Assignment'} · ${courseName}${courseSection}`, 40, 53);

  // Student & Meta info
  doc.setTextColor(30, 41, 59);
  doc.setFontSize(10);
  doc.text(`Student: ${studentName}${studentId ? ` (ID: ${studentId})` : ''}`, 40, 95);

  let submittedText = 'Not recorded';
  if (submission?.submitted_at) {
    try {
      submittedText = new Date(submission.submitted_at).toLocaleString();
    } catch (_) {
      submittedText = submission.submitted_at;
    }
  }
  doc.text(`Submitted: ${submittedText}`, 40, 110);

  if ((submission?.days_late ?? 0) > 0) {
    doc.setTextColor(180, 83, 9); // Amber 700
    doc.text(`Status: Submitted Late (+${submission.days_late} days)`, 40, 125);
    doc.setTextColor(30, 41, 59);
  }

  // Score Badge
  const score = finalScore(assignment, submission);
  const percent = score.possible > 0 ? ((score.earned / score.possible) * 100).toFixed(1) : '100.0';

  doc.setFillColor(239, 246, 255); // Blue 50
  doc.roundedRect(430, 85, 142, 54, 6, 6, 'F');
  doc.setTextColor(37, 99, 235); // Blue 600
  doc.setFontSize(9);
  doc.text('FINAL SCORE', 442, 102);
  doc.setFontSize(15);
  doc.text(`${score.earned} / ${score.possible} pts (${percent}%)`, 442, 124);

  let startY = 145;

  // Overall comments box if present
  if (submission?.feedback && submission.feedback.trim()) {
    doc.setDrawColor(191, 219, 254); // Blue 200
    doc.setFillColor(248, 250, 252); // Slate 50
    doc.roundedRect(40, startY, 532, 45, 4, 4, 'FD');

    doc.setTextColor(30, 58, 138); // Blue 900
    doc.setFontSize(9);
    doc.text('TEACHER COMMENTS:', 48, startY + 16);
    doc.setTextColor(15, 23, 42); // Slate 900
    doc.setFontSize(9);
    const splitFeedback = doc.splitTextToSize(submission.feedback.trim(), 516);
    doc.text(splitFeedback, 48, startY + 30);

    startY += 55;
  }

  // Questions breakdown table
  const headers = allowAnswers
    ? ['#', 'Question', 'Student Answer', 'Correct Answer', 'Points', 'Feedback']
    : ['#', 'Question', 'Student Answer', 'Points', 'Feedback'];

  const rows = (assignment?.questions || []).map((q, idx) => {
    const auto = submission?.auto?.per_question?.[q.id];
    const manual = submission?.manual?.[q.id];
    let earned = auto?.earned ?? 0;
    if (manual && manual.points !== null && manual.points !== undefined && manual.points !== '') {
      earned = Number(manual.points) || 0;
    }
    const possible = auto?.possible ?? (q.points || 0);
    const studentAns = answerToText(q, submission?.answers?.[q.id]);
    const feedback = manual?.feedback || '';

    // Strip HTML/Markdown tags for clean PDF table rendering
    const plainPrompt = (q.prompt || '').replace(/<[^>]+>/g, '').replace(/[*_#`$]/g, '').trim();

    if (allowAnswers) {
      const correctAns = describeCorrectAnswer(q) || '';
      return [
        String(idx + 1),
        plainPrompt.slice(0, 80) + (plainPrompt.length > 80 ? '...' : ''),
        studentAns.slice(0, 70) + (studentAns.length > 70 ? '...' : ''),
        correctAns.slice(0, 70) + (correctAns.length > 70 ? '...' : ''),
        `${earned} / ${possible}`,
        feedback
      ];
    }

    return [
      String(idx + 1),
      plainPrompt.slice(0, 100) + (plainPrompt.length > 100 ? '...' : ''),
      studentAns.slice(0, 80) + (studentAns.length > 80 ? '...' : ''),
      `${earned} / ${possible}`,
      feedback
    ];
  });

  const tableConfig = {
    startY,
    head: [headers],
    body: rows,
    theme: 'grid',
    headStyles: { fillColor: [30, 41, 59], fontSize: 8 },
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
    columnStyles: {
      0: { cellWidth: 20 },
      ...(allowAnswers ? {
        1: { cellWidth: 140 },
        2: { cellWidth: 100 },
        3: { cellWidth: 100 },
        4: { cellWidth: 50 },
        5: { cellWidth: 122 }
      } : {
        1: { cellWidth: 180 },
        2: { cellWidth: 140 },
        3: { cellWidth: 50 },
        4: { cellWidth: 142 }
      })
    },
    pageBreak: 'auto'
  };

  if (typeof doc.autoTable === 'function') {
    doc.autoTable(tableConfig);
  } else if (typeof autoTable === 'function') {
    autoTable(doc, tableConfig);
  }

  return doc;
}

/**
 * Generate a ZIP file containing feedback PDFs for all eligible rostered submissions.
 *
 * @param {object} params
 * @param {object} params.assignment
 * @param {Array<object>} params.submissions
 * @param {Array<object>} params.roster
 * @param {object} [params.course]
 * @param {Function} [params.onProgress]
 * @returns {Promise<{ blob: Blob, count: number, filename: string }>}
 */
export async function generateFeedbackZip({
  assignment,
  submissions = [],
  roster = [],
  course = null,
  onProgress = null
}) {
  const zip = new JSZip();
  const rosterMap = new Map((roster || []).map(s => [String(s.student_id).toUpperCase(), s]));

  const latestSubs = submissions.filter(s => s.is_latest !== false);
  const total = latestSubs.length;
  let processed = 0;

  const cleanAssignTitle = (assignment?.title || 'assignment').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 30);

  for (const sub of latestSubs) {
    const student = rosterMap.get(String(sub.student_id).toUpperCase()) || {
      student_id: sub.student_id,
      full_name: sub.student_name
    };

    const doc = generateSubmissionPDF({ assignment, submission: sub, student, course });
    const arrayBuffer = doc.output('arraybuffer');

    const cleanStudentId = String(student.student_id || 'student').replace(/[^a-z0-9_-]+/gi, '_');
    const pdfFilename = `${cleanStudentId}_${cleanAssignTitle}.pdf`;

    zip.file(pdfFilename, arrayBuffer);
    processed++;
    if (typeof onProgress === 'function') {
      onProgress(processed, total);
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const filename = `${cleanAssignTitle}_feedback_pdfs.zip`;

  return { blob, count: processed, filename };
}
