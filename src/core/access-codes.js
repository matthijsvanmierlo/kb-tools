import { storage } from './storage.js';

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
  /**
   * The secret that protects a student's grade report link: their access code when set,
   * otherwise their student ID (legacy behaviour, weaker because IDs are often known to peers).
   */
  static reportPassphrase(student) {
    return student.access_code ? normalizeAccessCode(student.access_code) : String(student.student_id || '');
  }

  static isWeak(student) {
    return !student.access_code;
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
    student.access_code = generateAccessCode();
    student.access_code_updated_at = new Date().toISOString();
    await storage.table('gradebook_students').put(student);
    return student;
  }

  static async setCustom(student, code) {
    const normalized = normalizeAccessCode(code);
    if (normalized.length < MIN_ACCESS_CODE_LENGTH) {
      throw new Error(`Access codes need at least ${MIN_ACCESS_CODE_LENGTH} letters or digits.`);
    }
    student.access_code = formatAccessCode(normalized);
    student.access_code_updated_at = new Date().toISOString();
    await storage.table('gradebook_students').put(student);
    return student;
  }

  /** CSV of roster codes for printing or mail-merge */
  static toCSV(students, course) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Class', 'Section', 'Student Name', 'Student ID', 'Access Code']];
    for (const s of students) {
      rows.push([course?.name, course?.section, s.full_name, s.student_id, s.access_code || '']);
    }
    return rows.map(r => r.map(esc).join(',')).join('\n');
  }
}

export default AccessCodes;
