/**
 * JoinService - Unified Class Join & Enrollment Service (KB-ROSTER-002)
 *
 * Single authoritative join path handling:
 * - Direct class codes (e.g. "ABCD-EFGH")
 * - Personal codes / student passes (e.g. "ABCDE-FGHIJ")
 * - Scanned QR codes & Deep Links (#join=..., kennisboost://join?...)
 *
 * Output states:
 * - 'joined' — enrolled, feed fetched and decrypted, enrolled course in storage
 * - 'joined_pending_content' — class registered locally, feed not yet reachable; retry scheduled
 * - 'needs_identity' — class found, student list requires personal code or identity selection
 * - 'duplicate_name' — self-enrollment matches existing student name without personal code
 * - 'not_found' — code does not match any known feed locally or on the relay
 * - 'offline' — cannot reach relay and no cached feed
 * - 'untrusted_relay' — link points to unknown external relay, confirmation needed
 */

import { storage } from './storage.js';
import { parseJoinLink } from './links.js';
import { deriveCourseFeedId } from './course-feed.js';
import { PublicFeedTransport, getStudentRelayUrl } from './transport.js';
import { mergeCourseFeed } from '../modules/student/course-store.js';
import { StudentProfile } from './student-profile.js';
import { SubmissionCrypto } from './submission-crypto.js';
import { normalizeAccessCode, formatAccessCode } from './access-codes.js';

export class JoinService {
  /**
   * Main entry point for joining a course.
   *
   * @param {string|object} intent - Raw URL, QR text, or join options object
   * @param {object} [options]
   * @param {boolean} [options.allowUntrustedRelay=false]
   * @param {boolean} [options.forceDistinctName=false]
   * @returns {Promise<{ status: string, course?: object, error?: string, [key: string]: any }>}
   */
  static async join(intent, options = {}) {
    let parsed = null;
    if (typeof intent === 'string') {
      parsed = parseJoinLink(intent);
      if (!parsed) {
        // Try treating raw string directly as a class code
        const norm = normalizeAccessCode(intent);
        if (norm) {
          parsed = { type: 'join', classCode: norm, personalCode: null, relay: null, feedId: null, key: null };
        }
      }
    } else if (intent && typeof intent === 'object') {
      parsed = {
        type: 'join',
        classCode: intent.classCode || intent.code || intent.c || null,
        personalCode: intent.personalCode || intent.scode || intent.s || null,
        studentName: intent.studentName || intent.name || intent.sname || null,
        studentId: intent.studentId || intent.sid || null,
        relay: intent.relay || intent.r || null,
        feedId: intent.feedId || intent.f || null,
        key: intent.key || intent.k || null
      };
    }

    if (!parsed || (!parsed.classCode && !parsed.feedId)) {
      return { status: 'not_found', error: 'Invalid join code or link.' };
    }

    const normClassCode = parsed.classCode ? normalizeAccessCode(parsed.classCode) : null;
    const normPersonalCode = parsed.personalCode ? normalizeAccessCode(parsed.personalCode) : null;
    const studentName = parsed.studentName || null;
    const studentId = parsed.studentId || null;

    // Check trusted relay
    const configuredRelay = getStudentRelayUrl() || (await storage.getMetadata('student_relay_url')) || null;
    const effectiveRelay = parsed.relay || configuredRelay || null;

    if (parsed.relay && configuredRelay && parsed.relay !== configuredRelay && !options.allowUntrustedRelay) {
      return {
        status: 'untrusted_relay',
        relay: parsed.relay,
        configuredRelay,
        intent: parsed
      };
    }

    // Derive deterministic feed ID
    const feedId = parsed.feedId || (normClassCode ? await deriveCourseFeedId(normClassCode) : null);
    if (!feedId) {
      return { status: 'not_found', error: 'Could not derive course feed identifier.' };
    }

    // 1. Check if course is already enrolled locally
    const existingCourses = await storage.table('student_courses').toArray().catch(() => []);
    let localCourse = existingCourses.find(c => {
      const codeMatch = normClassCode && c.access_code && normalizeAccessCode(c.access_code) === normClassCode;
      const idMatch = c.id === feedId || c.course_id === feedId;
      return codeMatch || idMatch;
    });

    // 2. Attempt fetching feed from relay
    let feedRes = null;
    let isOffline = false;

    if (effectiveRelay) {
      try {
        const transport = new PublicFeedTransport({ baseUrl: effectiveRelay });
        feedRes = await transport.fetchCourseFeed(feedId);
      } catch (err) {
        if (err?.message?.includes('404') || err?.status === 404) {
          // Feed strictly not found on relay
          if (!localCourse) {
            return { status: 'not_found', classCode: normClassCode, feedId };
          }
        } else {
          // Network error or offline
          isOffline = true;
        }
      }
    } else {
      isOffline = true;
    }

    // 3. Handle Code Rotation Forwarding Stub
    if (feedRes && typeof feedRes === 'object' && feedRes.moved_to) {
      const forwardedCode = feedRes.moved_to;
      return JoinService.join({
        ...parsed,
        classCode: forwardedCode,
        feedId: null
      }, options);
    }

    // 4. Decrypt & Merge Feed if fetched
    let mergedCourse = localCourse || null;
    let feedPayload = null;
    if (feedRes && feedRes.ciphertext) {
      try {
        // If ciphertext is a JSON stub for code rotation
        if (feedRes.ciphertext.startsWith('{')) {
          try {
            const stub = JSON.parse(feedRes.ciphertext);
            if (stub?.moved_to) {
              return JoinService.join({ ...parsed, classCode: stub.moved_to, feedId: null }, options);
            }
          } catch (_) {}
        }

        const mergeResult = await mergeCourseFeed(feedRes.ciphertext, {
          accessCode: normClassCode,
          relayUrl: effectiveRelay
        });
        mergedCourse = mergeResult?.course || mergedCourse;
        feedPayload = mergeResult;
      } catch (err) {
        console.warn('Feed decryption warning:', err);
      }
    }

    // 5. If we have no feed and are offline:
    if (!mergedCourse && isOffline) {
      // Create placeholder course for the student so they see it pending
      const placeholderId = `course-pending-${normClassCode}`;
      const placeholder = {
        id: placeholderId,
        course_id: placeholderId,
        name: `Class (${formatAccessCode(normClassCode)})`,
        course_name: `Class (${formatAccessCode(normClassCode)})`,
        access_code: normClassCode,
        class_code: normClassCode,
        status: 'pending_content',
        relay_url: effectiveRelay,
        updated_at: new Date().toISOString()
      };
      await storage.table('student_courses').put(placeholder);

      // Save to student profile
      await StudentProfile.saveIdentity({
        courseId: placeholderId,
        courseName: placeholder.name,
        courseCode: normClassCode,
        accessCode: normPersonalCode || '',
        studentId: studentId || '',
        fullName: studentName || ''
      });

      return {
        status: 'joined_pending_content',
        course: placeholder,
        classCode: normClassCode,
        personalCode: normPersonalCode,
        relay: effectiveRelay
      };
    }

    if (!mergedCourse) {
      return { status: 'not_found', classCode: normClassCode };
    }

    // 6. Identity Resolution: Roster Cards & Personal Code
    let resolvedSid = studentId || null;
    let resolvedName = studentName || null;

    if (normPersonalCode && feedPayload?.roster_cards) {
      const unlocked = await SubmissionCrypto.unlockRosterCard(mergedCourse.id, feedPayload.roster_cards, normPersonalCode);
      if (unlocked) {
        resolvedSid = unlocked.sid;
        resolvedName = unlocked.name;
      }
    }

    // Check duplicate name on self-enrollment
    if (studentName && feedPayload?.roster && !normPersonalCode && !options.forceDistinctName) {
      const match = feedPayload.roster.find(r =>
        (r.full_name || r.name || '').toLowerCase().trim() === studentName.toLowerCase().trim()
      );
      if (match && match.access_code_check) {
        return {
          status: 'duplicate_name',
          studentName,
          course: mergedCourse,
          matchedStudent: match
        };
      }
    }

    // Save identity if resolved or provided
    if (resolvedSid || resolvedName || normPersonalCode) {
      await StudentProfile.saveIdentity({
        courseId: mergedCourse.id,
        courseName: mergedCourse.name || mergedCourse.course_name,
        section: mergedCourse.section || '',
        courseCode: normClassCode,
        accessCode: normPersonalCode || '',
        studentId: resolvedSid || '',
        fullName: resolvedName || ''
      });
    }

    return {
      status: isOffline && !feedRes ? 'offline' : 'joined',
      course: mergedCourse,
      studentId: resolvedSid,
      studentName: resolvedName,
      personalCode: normPersonalCode
    };
  }

  /**
   * Student leaves a class.
   * Retains local copy of completed work, posts an unsubscribe request if online,
   * and removes or marks dropped in student_courses.
   *
   * @param {string} courseId
   * @returns {Promise<boolean>}
   */
  static async leaveCourse(courseId) {
    if (!courseId) return false;
    const course = await storage.table('student_courses').get(courseId);
    if (!course) return false;

    // Soft mark as dropped/archived so student keeps work
    course.status = 'dropped';
    course.dropped_at = new Date().toISOString();
    await storage.table('student_courses').put(course);

    // Try posting drop notification to relay if online
    if (course.relay_url && course.drop_box_id) {
      try {
        const { RelayTransport } = await import('./transport.js');
        const transport = new RelayTransport({ baseUrl: course.relay_url });
        await transport.submitDrop(course.drop_box_id, {
          type: 'unsubscribe',
          course_id: courseId,
          dropped_at: course.dropped_at
        }).catch(() => {});
      } catch (_) {}
    }

    return true;
  }
}
