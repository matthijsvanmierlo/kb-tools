/**
 * StudentMatcher - Multi-Signal Automatic Student Resolver (KB-STUDENT-002)
 *
 * Deterministically resolves an incoming submission or receipt to a rostered student
 * across 5 resilient stages:
 *  1. Cryptographic HMAC Signature Scan (matches exact student even if ID/Name had typos)
 *  2. Exact ID, Email, or Saved Alias match
 *  3. Normalized ID (strip leading zeros/formatting) & Canonical Name match (diacritics/split-name)
 *  4. LMS bulk-download filename heuristics (Canvas, Google Classroom, Moodle)
 *  5. Fuzzy suggestion scoring for assisted 1-click teacher mapping
 */

import { SubmissionCrypto } from './submission-crypto.js';
import { splitName, sortKey } from './names.js';
import { storage } from './storage.js';

function normalizeString(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function normalizeId(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^0+/, ''); // strip leading zeros
}

/** Compute bigram similarity between two normalized strings (0..1) */
export function stringSimilarity(s1, s2) {
  const str1 = normalizeString(s1);
  const str2 = normalizeString(s2);
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1.0;
  if (str1.length === 1 || str2.length === 1) return str1 === str2 ? 1 : 0;

  const pairs1 = new Set();
  for (let i = 0; i < str1.length - 1; i++) pairs1.add(str1.slice(i, i + 2));

  let matches = 0;
  for (let i = 0; i < str2.length - 1; i++) {
    if (pairs1.has(str2.slice(i, i + 2))) matches++;
  }

  return (2.0 * matches) / ((str1.length - 1) + (str2.length - 1));
}

/** Extract candidate student name tokens from LMS bulk-download filenames */
export function parseLmsFilename(filename = '') {
  if (!filename) return null;
  const base = filename.replace(/\.[^/.]+$/, '').trim();

  // Canvas: lastnamefirstname_12345_67890_AssignmentTitle
  const canvasMatch = base.match(/^([a-z]+(?:[a-z]+)?)_(\d+)_(\d+)_/i);
  if (canvasMatch) {
    return { token: canvasMatch[1].toLowerCase(), lms: 'canvas' };
  }

  // Moodle: Emma Watson_12345_assignsubmission_file_...
  const moodleMatch = base.match(/^([^_]+)_\d+_assignsubmission/i);
  if (moodleMatch) {
    return { name: moodleMatch[1].trim(), lms: 'moodle' };
  }

  // Google Classroom / generic prefix: [Name or ID] - Assignment.kbsub
  const hyphenMatch = base.match(/^([^-]+)\s*-\s*.+$/);
  if (hyphenMatch && hyphenMatch[1].trim().length >= 3) {
    return { token: hyphenMatch[1].trim(), lms: 'generic' };
  }

  return null;
}

export class StudentMatcher {
  /**
   * Deterministically resolve a submission to a student from a roster.
   *
   * @param {object} params
   * @param {object} params.body - Decrypted submission body ({ student_id, student_name, ... })
   * @param {string|null} [params.signature] - Access-code HMAC signature
   * @param {string} [params.source] - Origin filename or label
   * @param {Array<object>} params.roster - Students in the linked class
   * @returns {Promise<{
   *   matchedStudent: object|null,
   *   identity: 'verified'|'code_mismatch'|'no_code_on_file'|'not_in_roster',
   *   matchedBy: 'exact_id'|'access_code'|'email'|'alias'|'norm_id'|'canonical_name'|'lms_filename'|null,
   *   suggestedStudent: object|null,
   *   matchConfidence: number
   * }>}
   */
  static async resolveStudentForSubmission({ body = {}, claimedId = '', claimedName = '', signature = null, source = '', roster = [] }) {
    const rawId = String(claimedId || body?.student_id || '').trim();
    const rawName = String(claimedName || body?.student_name || '').trim();
    const effectiveBody = body && Object.keys(body).length ? body : { student_id: rawId, student_name: rawName };

    if ((!rawId && !rawName) || !roster.length) {
      return {
        matchedStudent: null,
        matched: null,
        identity: 'not_in_roster',
        matchedBy: null,
        suggestedStudent: null,
        suggested: null,
        matchConfidence: 0,
        confidence: 0
      };
    }

    const normBodyId = normalizeId(rawId);
    const normBodyName = normalizeString(rawName);

    // Helper to check current and historical access codes
    const verifyCodes = async (student) => {
      if (!student) return { ok: false };
      if (student.access_code && await SubmissionCrypto.verifyAccessCodeSignature(body, signature, student.access_code)) {
        return { ok: true, matchedBy: 'current_code' };
      }
      if (Array.isArray(student.previous_access_codes)) {
        for (const prev of student.previous_access_codes) {
          if (prev?.code && await SubmissionCrypto.verifyAccessCodeSignature(body, signature, prev.code)) {
            return { ok: true, matchedBy: 'previous_code', retired_at: prev.retired_at };
          }
        }
      }
      return { ok: false };
    };

    // -------------------------------------------------------------------------
    // Stage 1: Cryptographic Access-Code Scan
    // If a signature is present and exact ID check fails or mismatches, test
    // whether the signature matches any student's access code on the roster.
    // -------------------------------------------------------------------------
    if (signature) {
      // First check if the claimed ID directly matches and verifies
      const directMatch = roster.find(s => String(s.student_id).trim().toUpperCase() === rawId.toUpperCase());
      if (directMatch) {
        const check = await verifyCodes(directMatch);
        if (check.ok) {
          return {
            matchedStudent: directMatch,
            identity: 'verified',
            matchedBy: check.matchedBy === 'previous_code' ? 'previous_access_code' : 'exact_id',
            suggestedStudent: null,
            matchConfidence: 1.0,
            note: check.matchedBy === 'previous_code' ? 'Signed with previous access code' : null
          };
        }
      }

      // If direct match failed or didn't verify, scan other roster students with access codes
      for (const student of roster) {
        if (!student.access_code && (!student.previous_access_codes || !student.previous_access_codes.length)) continue;
        if (directMatch && student.id === directMatch.id) continue;

        const check = await verifyCodes(student);
        if (check.ok) {
          return {
            matchedStudent: student,
            identity: 'verified',
            matchedBy: check.matchedBy === 'previous_code' ? 'previous_access_code' : 'access_code',
            suggestedStudent: null,
            matchConfidence: 1.0,
            note: check.matchedBy === 'previous_code' ? 'Signed with previous access code' : null
          };
        }
      }
    }

    // -------------------------------------------------------------------------
    // Stage 2: Exact Student ID, Email, or Saved Alias
    // -------------------------------------------------------------------------
    const exactIdMatch = roster.find(s => String(s.student_id || '').trim().toUpperCase() === rawId.toUpperCase());
    if (exactIdMatch) {
      const hasAnyCode = exactIdMatch.access_code || (exactIdMatch.previous_access_codes && exactIdMatch.previous_access_codes.length > 0);
      let identity = 'no_code_on_file';
      let note = null;
      let matchedBy = 'exact_id';

      if (signature) {
        if (!hasAnyCode) {
          identity = 'no_code_on_file';
        } else {
          const check = await verifyCodes(exactIdMatch);
          if (check.ok) {
            identity = 'verified';
            if (check.matchedBy === 'previous_code') {
              matchedBy = 'previous_access_code';
              note = 'Signed with previous access code';
            }
          } else {
            identity = 'code_mismatch';
          }
        }
      }

      return {
        matchedStudent: exactIdMatch,
        identity,
        matchedBy,
        suggestedStudent: null,
        matchConfidence: 1.0,
        note
      };
    }

    // Email match (student typed their email as ID, or student_name is an email)
    const emailMatch = roster.find(s => {
      const email = String(s.email || '').trim().toLowerCase();
      if (!email) return false;
      const localPart = email.split('@')[0];
      const targetId = rawId.toLowerCase();
      return email === targetId || localPart === targetId;
    });

    if (emailMatch) {
      const identity = !emailMatch.access_code
        ? 'no_code_on_file'
        : signature && (await SubmissionCrypto.verifyAccessCodeSignature(body, signature, emailMatch.access_code))
          ? 'verified'
          : (signature ? 'code_mismatch' : 'no_code_on_file');
      return {
        matchedStudent: emailMatch,
        identity,
        matchedBy: 'email',
        suggestedStudent: null,
        matchConfidence: 0.95
      };
    }

    // Saved aliases (previously confirmed by teacher)
    const aliasMatch = roster.find(s => {
      if (!Array.isArray(s.aliases)) return false;
      return s.aliases.some(a => {
        const normAlias = normalizeString(a);
        return normAlias === normalizeString(rawId) || normAlias === normBodyName;
      });
    });

    if (aliasMatch) {
      const identity = !aliasMatch.access_code
        ? 'no_code_on_file'
        : signature && (await SubmissionCrypto.verifyAccessCodeSignature(body, signature, aliasMatch.access_code))
          ? 'verified'
          : (signature ? 'code_mismatch' : 'no_code_on_file');
      return {
        matchedStudent: aliasMatch,
        identity,
        matchedBy: 'alias',
        suggestedStudent: null,
        matchConfidence: 0.95
      };
    }

    // -------------------------------------------------------------------------
    // Stage 3: Normalized ID & Canonical Name Match
    // -------------------------------------------------------------------------
    if (normBodyId) {
      const bodyDigits = rawId.replace(/\D/g, '').replace(/^0+/, '');
      const normIdMatches = roster.filter(s => {
        const sNorm = normalizeId(s.student_id);
        if (sNorm === normBodyId) return true;
        if (bodyDigits && bodyDigits.length >= 2) {
          const sDigits = String(s.student_id || '').replace(/\D/g, '').replace(/^0+/, '');
          if (sDigits === bodyDigits) return true;
        }
        return false;
      });
      if (normIdMatches.length === 1) {
        const student = normIdMatches[0];
        const identity = !student.access_code
          ? 'no_code_on_file'
          : signature && (await SubmissionCrypto.verifyAccessCodeSignature(body, signature, student.access_code))
            ? 'verified'
            : (signature ? 'code_mismatch' : 'no_code_on_file');
        return {
          matchedStudent: student,
          matched: student,
          identity,
          matchedBy: 'norm_id',
          suggestedStudent: null,
          suggested: null,
          matchConfidence: 0.92,
          confidence: 0.92
        };
      }
    }

    // Canonical Name Match (diacritic-insensitive, handles "Last, First" vs "First Last")
    if (normBodyName) {
      const nameMatches = roster.filter(s => {
        const sFull = normalizeString(s.full_name);
        const sSplit = splitName(s.full_name || '');
        const bSplit = splitName(rawName);

        if (sFull === normBodyName) return true;
        if (sSplit.family && bSplit.family && sSplit.given && bSplit.given) {
          if (normalizeString(sSplit.family) === normalizeString(bSplit.family) &&
              normalizeString(sSplit.given) === normalizeString(bSplit.given)) {
            return true;
          }
        }
        return false;
      });

      if (nameMatches.length === 1) {
        const student = nameMatches[0];
        const identity = !student.access_code
          ? 'no_code_on_file'
          : signature && (await SubmissionCrypto.verifyAccessCodeSignature(body, signature, student.access_code))
            ? 'verified'
            : (signature ? 'code_mismatch' : 'no_code_on_file');
        return {
          matchedStudent: student,
          identity,
          matchedBy: 'canonical_name',
          suggestedStudent: null,
          matchConfidence: 0.90
        };
      }
    }

    // -------------------------------------------------------------------------
    // Stage 4: LMS Filename Heuristics
    // -------------------------------------------------------------------------
    const parsedLms = parseLmsFilename(source);
    if (parsedLms) {
      if (parsedLms.name) {
        const lmsNameMatches = roster.filter(s => normalizeString(s.full_name) === normalizeString(parsedLms.name));
        if (lmsNameMatches.length === 1) {
          const student = lmsNameMatches[0];
          return {
            matchedStudent: student,
            identity: student.access_code ? 'no_code_on_file' : 'no_code_on_file',
            matchedBy: 'lms_filename',
            suggestedStudent: null,
            matchConfidence: 0.88
          };
        }
      } else if (parsedLms.token) {
        // e.g. "watsonemma" -> match against lastName + firstName condensed
        const tokenMatches = roster.filter(s => {
          const split = splitName(s.full_name || '');
          const condensedLastFirst = normalizeString(`${split.family}${split.given}`).replace(/\s+/g, '');
          const condensedFirstLast = normalizeString(`${split.given}${split.family}`).replace(/\s+/g, '');
          const normToken = normalizeString(parsedLms.token).replace(/\s+/g, '');
          return condensedLastFirst === normToken || condensedFirstLast === normToken || normalizeId(s.student_id) === normToken;
        });

        if (tokenMatches.length === 1) {
          const student = tokenMatches[0];
          return {
            matchedStudent: student,
            identity: 'no_code_on_file',
            matchedBy: 'lms_filename',
            suggestedStudent: null,
            matchConfidence: 0.85
          };
        }
      }
    }

    // -------------------------------------------------------------------------
    // Stage 5: Top Fuzzy Suggestion for Unmapped ("not_in_roster") Submissions
    // -------------------------------------------------------------------------
    let topCandidate = null;
    let highestScore = 0;

    for (const student of roster) {
      const sFull = student.full_name || '';
      const sId = student.student_id || '';

      const nameScore = rawName ? stringSimilarity(sFull, rawName) : 0;
      const idScore = rawId ? stringSimilarity(sId, rawId) : 0;
      const score = Math.max(nameScore, idScore);

      if (score > highestScore && score >= 0.55) {
        highestScore = score;
        topCandidate = student;
      }
    }

    return {
      matchedStudent: null,
      matched: null,
      identity: topCandidate ? 'suggested_match' : 'not_in_roster',
      matchedBy: null,
      suggestedStudent: topCandidate,
      suggested: topCandidate,
      matchConfidence: Math.round(highestScore * 100) / 100,
      confidence: Math.round(highestScore * 100) / 100
    };
  }

  /**
   * Persist a confirmed alias to a student's roster record in IndexedDB so future
   * submissions auto-resolve immediately.
   */
  static async addStudentAlias(studentId, courseId, alias) {
    if (!studentId || !alias) return;
    try {
      const table = storage.table('gradebook_students');
      let student = null;
      if (courseId) {
        student = await table.where('[course_id+student_id]').equals([courseId, studentId]).first();
        if (!student) {
          student = await table.where('[course_id+student_id]').equals([studentId, courseId]).first();
        }
      }
      if (!student) {
        student = await table.where('student_id').equals(studentId).first()
          || (courseId ? await table.where('student_id').equals(courseId).first() : null);
      }
      if (student) {
        const aliases = new Set(Array.isArray(student.aliases) ? student.aliases : []);
        aliases.add(String(alias).trim());
        student.aliases = Array.from(aliases);
        student.updated_at = new Date().toISOString();
        await table.put(student);
      }
    } catch (e) {
      console.warn('Could not save student alias:', e);
    }
  }

  /**
   * Search across all classes for existing student records to prevent duplicates and enable cross-class identity sharing.
   */
  static async findExistingStudentAcrossClasses({ studentId = '', fullName = '', email = '', currentCourseId = null } = {}) {
    const rawId = String(studentId || '').trim();
    const normId = normalizeId(rawId);
    const rawName = String(fullName || '').trim();
    const normName = normalizeString(rawName);
    const rawEmail = String(email || '').trim().toLowerCase();

    const allStudents = await storage.table('gradebook_students').toArray().catch(() => []);
    let sameClassMatch = null;
    const otherClassMatches = [];

    for (const s of allStudents) {
      const sId = String(s.student_id || '').trim();
      const sNormId = normalizeId(sId);
      const sName = String(s.full_name || '').trim();
      const sNormName = normalizeString(sName);
      const sEmail = String(s.email || '').trim().toLowerCase();

      const idMatch = Boolean(normId && sNormId && sNormId === normId);
      const emailMatch = Boolean(rawEmail && sEmail && sEmail === rawEmail);
      const nameMatch = Boolean(normName && sNormName && (normName === sNormName || stringSimilarity(sName, rawName) > 0.88));

      const isMatch = idMatch || emailMatch || (nameMatch && (idMatch || emailMatch || !rawId || !sId));

      if (isMatch) {
        if (currentCourseId && String(s.course_id) === String(currentCourseId)) {
          if (!sameClassMatch) sameClassMatch = s;
        } else {
          otherClassMatches.push(s);
        }
      }
    }

    let canonicalCandidate = null;
    if (otherClassMatches.length > 0) {
      canonicalCandidate = [...otherClassMatches].sort((a, b) => {
        const scoreA = (a.access_code ? 4 : 0) + (a.email ? 2 : 0) + (a.full_name ? 1 : 0);
        const scoreB = (b.access_code ? 4 : 0) + (b.email ? 2 : 0) + (b.full_name ? 1 : 0);
        return scoreB - scoreA;
      })[0];
    }

    return {
      sameClassMatch,
      otherClassMatches,
      canonicalCandidate
    };
  }
}

export default StudentMatcher;
