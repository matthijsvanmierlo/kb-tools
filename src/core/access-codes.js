import { storage } from './storage.js';
import { toCSV } from './csv.js';
import { Sanitizer } from './sanitizer.js';

/**
 * Student Access Codes - KB-CORE-007
 *
 * Each student gets a private, teacher-issued code. It unlocks the student's encrypted grade
 * report link and signs their assignment submissions (see submission-crypto.js). Codes use an
 * unambiguous alphabet (no 0/O, 1/I/L) and are shown grouped, e.g. "K7M2-QX9P".
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateAccessCode(length = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeAccessCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatAccessCode(code) {
  const n = normalizeAccessCode(code);
  return n.length > 4 ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
}

/** Codes shorter than this are rejected when a teacher sets one manually */
export const MIN_ACCESS_CODE_LENGTH = 6;

export class AccessCodes {
  static generateCode(length = 8) {
    return generateAccessCode(length);
  }

  /**
   * The secret that protects a student's grade report and feedback links: their access code.
   * Student IDs are never used as a fallback (classmates often know them); call ensureForStudent first.
   */
  static reportPassphrase(student) {
    if (!student?.access_code) throw new Error('NO_ACCESS_CODE');
    return normalizeAccessCode(student.access_code);
  }

  /**
   * Give a student a code if they have none, so a private link can be made for them.
   * @returns {Promise<string|null>} the newly created code, or null if they already had one
   */
  static async ensureForStudent(student) {
    if (student?.access_code) return null;
    if (!student?.id) throw new Error('NO_ACCESS_CODE');
    await this.regenerate(student);
    return student.access_code;
  }

  /** Make sure every student in a course has a code; returns the updated students */
  static async ensureForCourse(courseId) {
    const table = storage.table('gradebook_students');
    const students = await table.where('course_id').equals(courseId).toArray();
    const updated = [];
    for (const s of students) {
      if (!s.access_code) {
        s.access_code = generateAccessCode();
        s.access_code_updated_at = new Date().toISOString();
        await table.put(s);
        updated.push(s);
      }
    }
    return students;
  }

  static async regenerate(student) {
    const now = new Date().toISOString();
    if (student.access_code) {
      student.previous_access_codes = Array.isArray(student.previous_access_codes) ? [...student.previous_access_codes] : [];
      student.previous_access_codes.unshift({ code: student.access_code, retired_at: now });
      if (student.previous_access_codes.length > 5) student.previous_access_codes.length = 5;
    }
    student.access_code = generateAccessCode();
    student.access_code_updated_at = now;
    await storage.table('gradebook_students').put(student);
    return student;
  }

  static async setCustom(student, code) {
    const normalized = normalizeAccessCode(code);
    if (normalized.length < MIN_ACCESS_CODE_LENGTH) {
      throw new Error(`Access codes need at least ${MIN_ACCESS_CODE_LENGTH} letters or digits.`);
    }
    const now = new Date().toISOString();
    if (student.access_code && normalizeAccessCode(student.access_code) !== normalized) {
      student.previous_access_codes = Array.isArray(student.previous_access_codes) ? [...student.previous_access_codes] : [];
      student.previous_access_codes.unshift({ code: student.access_code, retired_at: now });
      if (student.previous_access_codes.length > 5) student.previous_access_codes.length = 5;
    }
    student.access_code = formatAccessCode(normalized);
    student.access_code_updated_at = now;
    await storage.table('gradebook_students').put(student);
    return student;
  }

  /** Build a direct setup link that auto-populates the student's keychain */
  static createOnboardingPassUrl(student, course, baseUrl = (typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '')) {
    const courseCode = course?.access_code || '';
    const studentCode = student.access_code || '';
    const params = new URLSearchParams({
      sid: student.student_id || '',
      sname: student.full_name || '',
      code: courseCode || studentCode || '',
      scode: studentCode,
      cid: course?.id || '',
      cname: course?.name || '',
      csec: course?.section || ''
    });
    return `${baseUrl}#/student/courses?${params.toString()}`;
  }

  /** CSV of roster codes for printing or mail-merge */
  static toCSV(students, course, baseUrl = '') {
    const rows = students.map(s => ({
      Class: course?.name || '',
      Section: course?.section || '',
      'Student Name': s.full_name || '',
      'Student ID': s.student_id || '',
      'Access Code': s.access_code || '',
      'Onboarding Link': AccessCodes.createOnboardingPassUrl(s, course, baseUrl)
    }));
    return toCSV(rows, ['Class', 'Section', 'Student Name', 'Student ID', 'Access Code', 'Onboarding Link']);
  }

  /** Print cut-out slips for students */
  static printSlips(students = [], course = {}) {
    if (typeof window === 'undefined') return;
    const w = window.open('', '_blank');
    if (!w) {
      alert('Allow pop-ups to print code slips.');
      return;
    }
    const esc = v => Sanitizer.escapeHTML(v);
    const slips = students.filter(s => s.access_code).map(s => {
      const link = AccessCodes.createOnboardingPassUrl(s, course);
      return `
      <div class="slip">
        <div class="cls">${esc(course?.name || 'Class')}${course?.section ? ` · ${esc(course.section)}` : ''}</div>
        <div class="name">${esc(s.full_name || '')}</div>
        <div class="id">Student ID: ${esc(s.student_id || '')}</div>
        <div class="code">${esc(s.access_code || '')}</div>
        <div class="setup-url">Auto-setup link: <span class="url-text">${esc(link)}</span></div>
        <div class="hint">Keep this code private. You need it to view your grades and hand in assignments.</div>
      </div>
    `;
    }).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Access codes — ${esc(course?.name || 'Class')}</title>
      <style>
        body { font-family: system-ui, sans-serif; margin: 24px; color: #0f172a; }
        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
        .slip { border: 1px dashed #94a3b8; border-radius: 10px; padding: 14px; break-inside: avoid; }
        .cls { font-size: 11px; color: #64748b; }
        .name { font-weight: 700; font-size: 16px; margin-top: 4px; }
        .id { font-size: 12px; color: #475569; }
        .code { font-family: ui-monospace, monospace; font-size: 22px; letter-spacing: .12em; margin: 8px 0; font-weight: 700; }
        .setup-url { font-size: 10px; color: #2563eb; margin-bottom: 6px; word-break: break-all; }
        .hint { font-size: 10px; color: #64748b; }
      </style>
      </head><body><div class="grid">${slips}</div><script>window.onload=()=>window.print()<\/script></body></html>`);
    w.document.close();
  }
}

export default AccessCodes;
