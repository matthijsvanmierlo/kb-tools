import jszipLib from 'jszip';
import { parseCSV } from './csv.js';

const JSZip = jszipLib.default || jszipLib;

/**
 * Case-insensitive property lookup for parsed row objects.
 * @param {object} obj
 * @param {...string} names
 * @returns {string}
 */
function getProp(obj, ...names) {
  if (!obj || typeof obj !== 'object') return '';
  const keys = Object.keys(obj);
  for (const name of names) {
    const clean = name.toLowerCase().replace(/[\s_\-.]+/g, '');
    const foundKey = keys.find(k => k.toLowerCase().replace(/[\s_\-.]+/g, '') === clean);
    if (foundKey && obj[foundKey] !== undefined && obj[foundKey] !== null) {
      return String(obj[foundKey]).trim();
    }
  }
  return '';
}

/**
 * Parse a OneRoster 1.1/1.2 bundle (ZIP archive or object with CSV strings).
 * @param {object|Blob|File|ArrayBuffer|Uint8Array} input
 * @returns {Promise<{ classes: Array<{ sourcedId: string, title: string, classCode: string, schoolYear: string, students: Array<{ student_id: string, given_name: string, family_name: string, email: string, sourced_id: string }> }> }>}
 */
export async function parseOneRosterBundle(input) {
  let usersCsv = '';
  let classesCsv = '';
  let enrollmentsCsv = '';

  if (!input) {
    return { classes: [] };
  }

  // Check if input is a ZIP (File, Blob, ArrayBuffer, Uint8Array)
  const isZip = (typeof Blob !== 'undefined' && input instanceof Blob) ||
    (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) ||
    (typeof Uint8Array !== 'undefined' && input instanceof Uint8Array) ||
    (input && input.name && input.name.toLowerCase().endsWith('.zip'));

  if (isZip) {
    const zip = await JSZip.loadAsync(input);
    const files = Object.keys(zip.files);

    for (const filePath of files) {
      if (filePath.includes('__MACOSX') || filePath.endsWith('/')) continue;
      const lower = filePath.toLowerCase();
      if (lower.endsWith('users.csv')) {
        usersCsv = await zip.file(filePath).async('string');
      } else if (lower.endsWith('classes.csv')) {
        classesCsv = await zip.file(filePath).async('string');
      } else if (lower.endsWith('enrollments.csv')) {
        enrollmentsCsv = await zip.file(filePath).async('string');
      }
    }
  } else if (typeof input === 'object') {
    usersCsv = input.usersCsv || input.users || '';
    classesCsv = input.classesCsv || input.classes || '';
    enrollmentsCsv = input.enrollmentsCsv || input.enrollments || '';
  }

  const parsedUsers = usersCsv ? parseCSV(usersCsv).rows : [];
  const parsedClasses = classesCsv ? parseCSV(classesCsv).rows : [];
  const parsedEnrollments = enrollmentsCsv ? parseCSV(enrollmentsCsv).rows : [];

  // Index users by sourcedId
  const usersMap = new Map();
  for (const u of parsedUsers) {
    const sourcedId = getProp(u, 'sourcedId', 'sourced_id', 'id');
    if (sourcedId) {
      usersMap.set(sourcedId.toLowerCase(), u);
    }
  }

  // Filter student enrollments
  // Group student enrollments by classSourcedId
  const enrollmentsByClass = new Map();
  for (const en of parsedEnrollments) {
    const role = getProp(en, 'role').toLowerCase();
    const status = getProp(en, 'status').toLowerCase();
    if (role !== 'student') continue;
    if (status === 'tobedeleted') continue;

    const classSourcedId = getProp(en, 'classSourcedId', 'class_sourced_id').toLowerCase();
    if (!classSourcedId) continue;

    if (!enrollmentsByClass.has(classSourcedId)) {
      enrollmentsByClass.set(classSourcedId, []);
    }
    enrollmentsByClass.get(classSourcedId).push(en);
  }

  const classes = [];

  for (const c of parsedClasses) {
    const classSourcedId = getProp(c, 'sourcedId', 'sourced_id', 'id');
    const classKey = classSourcedId.toLowerCase();
    const title = getProp(c, 'title', 'name') || 'Untitled Class';
    const classCode = getProp(c, 'classCode', 'class_code', 'code');
    const schoolYear = getProp(c, 'schoolYear', 'school_year', 'academic_year');

    const classEnrollments = enrollmentsByClass.get(classKey) || [];
    const students = [];
    const seenStudentIds = new Set();

    for (const en of classEnrollments) {
      const userSourcedId = getProp(en, 'userSourcedId', 'user_sourced_id');
      const user = usersMap.get(userSourcedId.toLowerCase());
      if (!user) continue;

      const student_id = getProp(user, 'identifier') || getProp(user, 'sourcedId', 'sourced_id') || getProp(user, 'username');
      if (!student_id) continue;

      const idLower = student_id.toLowerCase();
      if (seenStudentIds.has(idLower)) continue;
      seenStudentIds.add(idLower);

      students.push({
        student_id,
        given_name: getProp(user, 'givenName', 'given_name', 'firstname', 'first'),
        family_name: getProp(user, 'familyName', 'family_name', 'lastname', 'last'),
        email: getProp(user, 'email', 'emailAddress', 'mail'),
        sourced_id: getProp(user, 'sourcedId', 'sourced_id')
      });
    }

    classes.push({
      sourcedId: classSourcedId,
      title,
      classCode,
      schoolYear,
      students
    });
  }

  return { classes };
}
