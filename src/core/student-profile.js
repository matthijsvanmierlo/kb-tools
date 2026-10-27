/**
 * StudentProfile - Persistent Student Identity Keychain (KB-STUDENT-001)
 *
 * Persists the student's identity and class-specific access codes so they never have to
 * re-type their Student ID, Name, or Access Code on assignments or interactive videos.
 * Also stores candidate access codes for zero-click auto-decryption of shared feedback
 * links and grade reports.
 */

import { storage } from './storage.js';
import { normalizeAccessCode, formatAccessCode } from './access-codes.js';

const STORAGE_KEY = 'kb_student_profile_v1';

function normalizeCourseKey(courseId, courseName, section) {
  if (courseId) return String(courseId).trim().toLowerCase();
  const name = String(courseName || 'class').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const sec = String(section || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return sec ? `${name}__${sec}` : name;
}

export class StudentProfile {
  /**
   * Synchronously read student profile from localStorage with fallback to default shape.
   * @returns {{
   *   defaultIdentity: { student_id: string, full_name: string, email: string },
   *   classes: Record<string, {
   *     course_id?: string,
   *     course_name: string,
   *     section?: string,
   *     teacher_fingerprint?: string,
   *     student_id: string,
   *     full_name: string,
   *     access_code: string,
   *     updated_at: string
   *   }>
   * }}
   */
  static get() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            return {
              defaultIdentity: parsed.defaultIdentity || { student_id: '', full_name: '', email: '' },
              classes: parsed.classes || {}
            };
          }
        }
      }
    } catch (_) {}

    return {
      defaultIdentity: { student_id: '', full_name: '', email: '' },
      classes: {}
    };
  }

  /**
   * Save or update student identity and access code for a class (or default).
   */
  static async saveIdentity({
    studentId,
    fullName,
    email = '',
    accessCode = '',
    courseId = null,
    courseName = '',
    section = '',
    teacherFingerprint = ''
  }) {
    const profile = this.get();
    const sid = String(studentId || '').trim();
    const name = String(fullName || '').trim();
    const em = String(email || '').trim();
    const normCode = normalizeAccessCode(accessCode);

    if (sid || name) {
      profile.defaultIdentity = {
        student_id: sid || profile.defaultIdentity.student_id,
        full_name: name || profile.defaultIdentity.full_name,
        email: em || profile.defaultIdentity.email
      };
    }

    if (courseId || courseName || normCode) {
      const cKey = normalizeCourseKey(courseId, courseName, section);
      const existing = profile.classes[cKey] || {};
      profile.classes[cKey] = {
        course_id: courseId || existing.course_id || null,
        course_name: courseName || existing.course_name || 'Class',
        section: section || existing.section || '',
        teacher_fingerprint: teacherFingerprint || existing.teacher_fingerprint || '',
        student_id: sid || existing.student_id || profile.defaultIdentity.student_id,
        full_name: name || existing.full_name || profile.defaultIdentity.full_name,
        access_code: normCode || existing.access_code || '',
        updated_at: new Date().toISOString()
      };
    }

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
      }
      await storage.setMetadata('student_profile', profile).catch(() => {});
    } catch (_) {}

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kb-student-profile-changed', { detail: profile }));
    }

    return profile;
  }

  /**
   * Convenience helper to attach an access code to a specific enrolled course.
   */
  static async saveClassAccessCode(courseId, accessCode) {
    return this.saveIdentity({ courseId, accessCode });
  }

  /**
   * Given an incoming assignment or video payload + share params, resolve the best matching
   * student name, student ID, and access code.
   *
   * Priority:
   * 1. Explicit URL parameters (sid, sname, code)
   * 2. Class keychain match (by payload.class_id, course_meta, or teacher_key.fingerprint)
   * 3. Default identity profile
   */
  static resolveForPayload(payload = {}, shareParams = {}) {
    const profile = this.get();
    const urlSid = shareParams?.sid || '';
    const urlSname = shareParams?.sname || '';
    const urlCode = shareParams?.code || '';

    let classMatch = null;
    const courseId = payload.course_id || payload.class_id || payload.course_meta?.course_id || payload.course_meta?.id;
    const courseName = payload.course_meta?.course_name || payload.course_meta?.name;
    const section = payload.course_meta?.section;
    const teacherFp = payload.teacher_key?.fingerprint || payload.secure?.key_fingerprint;

    if (courseId || courseName) {
      const cKey = normalizeCourseKey(courseId, courseName, section);
      classMatch = profile.classes[cKey] || null;
    }

    if (!classMatch && teacherFp) {
      classMatch = Object.values(profile.classes).find(c => c.teacher_fingerprint === teacherFp) || null;
    }

    const student_id = urlSid || classMatch?.student_id || profile.defaultIdentity.student_id || '';
    const full_name = urlSname || classMatch?.full_name || profile.defaultIdentity.full_name || '';
    const access_code = normalizeAccessCode(urlCode || classMatch?.access_code || '');

    return {
      student_id,
      full_name,
      access_code: formatAccessCode(access_code),
      raw_code: access_code,
      hasSavedIdentity: Boolean(student_id && full_name),
      isClassMatch: Boolean(classMatch)
    };
  }

  /**
   * Return candidate access codes from the student's keychain for automatic link decryption.
   * @param {string|null} [hintCourseKey]
   * @returns {string[]} Deduplicated normalized access codes
   */
  static candidateAccessCodes(hintCourseKey = null) {
    const profile = this.get();
    const codes = new Set();

    if (hintCourseKey && profile.classes[hintCourseKey]?.access_code) {
      codes.add(normalizeAccessCode(profile.classes[hintCourseKey].access_code));
    }

    for (const c of Object.values(profile.classes || {})) {
      if (c.access_code) {
        codes.add(normalizeAccessCode(c.access_code));
      }
    }

    return Array.from(codes).filter(Boolean);
  }

  /**
   * Build a Student Onboarding Pass payload.
   * @param {object} student
   * @param {object} course
   * @returns {object}
   */
  static createOnboardingPass({ student, course }) {
    return {
      version: 1,
      kind: 'student_pass',
      created_at: new Date().toISOString(),
      student: {
        student_id: student.student_id,
        full_name: student.full_name,
        email: student.email || ''
      },
      course: {
        id: course.id,
        name: course.name,
        section: course.section || '',
        academic_year: course.academic_year || ''
      },
      access_code: normalizeAccessCode(student.access_code || '')
    };
  }

  /**
   * Import a Student Onboarding Pass payload directly into the local student profile.
   * @param {object} passPayload
   * @returns {Promise<object>}
   */
  static async importOnboardingPass(passPayload) {
    if (!passPayload || passPayload.kind !== 'student_pass') {
      throw new Error('INVALID_STUDENT_PASS');
    }

    const { student, course, access_code } = passPayload;
    return this.saveIdentity({
      studentId: student?.student_id,
      fullName: student?.full_name,
      email: student?.email,
      accessCode: access_code,
      courseId: course?.id,
      courseName: course?.name,
      section: course?.section
    });
  }
}

export default StudentProfile;
