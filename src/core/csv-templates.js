/**
 * CSV Templates & Generation Library
 * Provides standard, accessible CSV templates and download helpers for all
 * educational data imports and exports across KennisBoost Tools.
 */

import { toCSV, downloadCSV } from './csv.js';

export const ROSTER_CSV_TEMPLATE = `StudentID,FirstName,LastName,FullName,Email,Notes
"S101","Emma","Watson","Emma Watson","emma.watson@school.edu","Period 1"
"S102","Liam","Smith","Liam Smith","liam.smith@school.edu","Period 1"
"S103","Sophia","Garcia","Sophia Garcia","sophia.garcia@school.edu","Period 1"`;

export const FLASHCARDS_CSV_TEMPLATE = `Question,Answer
"Photosynthesis","Process used by green plants and certain other organisms to synthesize nutrients from carbon dioxide and water using sunlight"
"Mitochondria","The powerhouse of the cell, generating most of the chemical energy needed to power biochemical reactions"
"Newton's First Law","An object will remain at rest or move at a constant velocity unless acted upon by a net external force"
"What is the capital of Japan?","Tokyo"`;

export const TIMELINE_CSV_TEMPLATE = `Title,Start Date,End Date,Category,Description,Color,Citations
"Apollo 11 Moon Landing","1969-07-20","","Space Exploration","First manned mission to land on the Moon with Neil Armstrong and Buzz Aldrin.","#2563eb","NASA"
"World War II","1939-09-01","1945-09-02","History","Global military conflict involving the vast majority of the world's countries.","#e11d48","National Archives"
"Invention of the Printing Press","1440","","Technology","Johannes Gutenberg introduces movable type printing to Europe, revolutionizing communication.","#7c3aed","British Library"`;

export const STANDARDS_CSV_TEMPLATE = `Code,Description
"HS-PS1-1","Use the periodic table as a model to predict the relative properties of elements based on patterns of electrons in the outermost energy level."
"HS-PS1-2","Construct and revise an explanation for the outcome of a simple chemical reaction based on outermost electron states and periodic trends."`;

/**
 * Generate a dynamic grades CSV template matching the active course's assignments
 * @param {object} [course]
 * @param {Array<object>} [assignments]
 * @param {Array<object>} [students]
 * @returns {string} CSV text
 */
export function getGradesCSVTemplate(course = {}, assignments = [], students = []) {
  const assignmentCols = assignments.length > 0
    ? assignments.map(a => a.title || 'Assignment')
    : ['Quiz 1', 'Homework 1', 'Midterm Exam', 'Project 1'];

  const headers = ['StudentID', 'StudentName', ...assignmentCols];

  const sampleRows = students.length > 0
    ? students.slice(0, 3).map((s, idx) => {
        const row = {
          StudentID: s.student_id || `S10${idx + 1}`,
          StudentName: s.full_name || `Student ${idx + 1}`
        };
        assignmentCols.forEach((col, cIdx) => {
          row[col] = String(90 - (idx * 5) + (cIdx * 2));
        });
        return row;
      })
    : [
        {
          StudentID: 'S101',
          StudentName: 'Emma Watson',
          ...Object.fromEntries(assignmentCols.map((c, i) => [c, String(95 - i * 2)]))
        },
        {
          StudentID: 'S102',
          StudentName: 'Liam Smith',
          ...Object.fromEntries(assignmentCols.map((c, i) => [c, String(88 + i * 3)]))
        },
        {
          StudentID: 'S103',
          StudentName: 'Sophia Garcia',
          ...Object.fromEntries(assignmentCols.map((c, i) => [c, String(92 - i * 1)]))
        }
      ];

  return toCSV(sampleRows, headers);
}

/**
 * Generate a CSV template for a given export preset
 * @param {object} preset - Export preset from ExportDialog
 * @param {Array<string>} [headers] - Available column headers
 * @returns {string} CSV template string
 */
export function getExportPresetTemplate(preset, headers = []) {
  if (!headers || headers.length === 0) {
    if (preset?.id === 'mail_merge') {
      headers = ['StudentID', 'LastName', 'FirstName', 'FullName', 'Email', 'OverallScore', 'Letter', 'MissingCount', 'LateCount', 'ReportLink'];
    } else if (preset?.id === 'wide_grades') {
      headers = ['StudentID', 'Student', 'Assignment 1', 'Assignment 2', 'Assignment 3', 'Overall', 'Letter'];
    } else if (preset?.id === 'canvas') {
      headers = ['Student', 'ID', 'SIS User ID', 'SIS Login ID', 'Section', 'Assignment 1', 'Assignment 2'];
    } else if (preset?.id === 'submissions') {
      headers = ['StudentID', 'FullName', 'SubmittedAt', 'Score', 'MaxScore', 'Percent', 'Status', 'Feedback'];
    } else if (preset?.id === 'roster') {
      headers = ['StudentID', 'FirstName', 'LastName', 'FullName', 'Email', 'AccessCode'];
    } else {
      headers = ['StudentID', 'FullName', 'Score', 'Notes'];
    }
  }

  // Build 2 clean sample rows with placeholder data
  const sampleRows = [
    headers.reduce((acc, h) => {
      const lower = h.toLowerCase();
      if (lower.includes('id')) acc[h] = 'S101';
      else if (lower.includes('first')) acc[h] = 'Emma';
      else if (lower.includes('last')) acc[h] = 'Watson';
      else if (lower.includes('name') || lower === 'student') acc[h] = 'Emma Watson';
      else if (lower.includes('email') || lower.includes('login')) acc[h] = 'emma.watson@school.edu';
      else if (lower.includes('score') || lower.includes('percent')) acc[h] = '95';
      else if (lower.includes('max')) acc[h] = '100';
      else if (lower.includes('letter')) acc[h] = 'A';
      else if (lower.includes('link')) acc[h] = 'https://example.school.edu/report/S101';
      else if (lower.includes('count') || lower.includes('late') || lower.includes('miss')) acc[h] = '0';
      else if (lower.includes('status')) acc[h] = 'Graded';
      else acc[h] = 'Sample Data';
      return acc;
    }, {}),
    headers.reduce((acc, h) => {
      const lower = h.toLowerCase();
      if (lower.includes('id')) acc[h] = 'S102';
      else if (lower.includes('first')) acc[h] = 'Liam';
      else if (lower.includes('last')) acc[h] = 'Smith';
      else if (lower.includes('name') || lower === 'student') acc[h] = 'Liam Smith';
      else if (lower.includes('email') || lower.includes('login')) acc[h] = 'liam.smith@school.edu';
      else if (lower.includes('score') || lower.includes('percent')) acc[h] = '88';
      else if (lower.includes('max')) acc[h] = '100';
      else if (lower.includes('letter')) acc[h] = 'B+';
      else if (lower.includes('link')) acc[h] = 'https://example.school.edu/report/S102';
      else if (lower.includes('count') || lower.includes('late') || lower.includes('miss')) acc[h] = '0';
      else if (lower.includes('status')) acc[h] = 'Graded';
      else acc[h] = 'Sample Data';
      return acc;
    }, {})
  ];

  return toCSV(sampleRows, headers);
}

/**
 * Trigger download of a named CSV template file
 * @param {string} filename
 * @param {string} content
 */
export function downloadCSVTemplate(filename, content) {
  const safeFilename = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  downloadCSV(safeFilename, content);
}
