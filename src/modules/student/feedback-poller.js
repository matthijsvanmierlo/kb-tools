/**
 * FeedbackPoller - Periodically fetches remote feedback for enrolled student work.
 * Polls on boot, on visibility visible, and every 5 minutes.
 */

import { storage } from '../../core/storage.js';
import { StudentProfile } from '../../core/student-profile.js';
import { FeedbackCapsule } from '../../core/feedback-capsule.js';
import { StudentLedger } from './ledger.js';

export class RemoteFeedbackPoller {
  constructor() {
    this._timer = null;
    this._running = false;
    this._onVisibilityChange = null;
  }

  start() {
    if (typeof window === 'undefined' || this._timer) return;

    const poll = () => {
      if (document.visibilityState === 'visible') {
        this.pollAll().catch(console.warn);
      }
    };

    this._timer = setInterval(poll, 5 * 60 * 1000); // Every 5 minutes

    this._onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        poll();
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    // Initial check after 2 seconds
    setTimeout(poll, 2000);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
  }

  /**
   * Poll all candidate drops for available student feedback.
   */
  async pollAll() {
    if (this._running) return;
    this._running = true;
    try {
      const profile = StudentProfile.get();
      const syncConfig = (await storage.getMetadata('sync_config')) || {};
      const relayBaseUrl = syncConfig.baseUrl || '';

      const [ledgerEntries, studentItems, courses] = await Promise.all([
        storage.table('student_ledger').toArray().catch(() => []),
        storage.table('student_items').toArray().catch(() => []),
        storage.table('student_courses').toArray().catch(() => [])
      ]);

      const courseRelayMap = new Map();
      for (const c of courses) {
        if (c.relay_url || c.base_url) courseRelayMap.set(c.id, c.relay_url || c.base_url);
      }

      // Collect all student access codes across profile and entries
      const accessCodesByCourse = new Map();
      for (const [classKey, cls] of Object.entries(profile.classes || {})) {
        if (cls.access_code) {
          const cid = cls.course_id || classKey;
          const codes = accessCodesByCourse.get(cid) || new Set();
          codes.add(cls.access_code);
          accessCodesByCourse.set(cid, codes);
        }
      }

      // Items that may have remote feedback
      const pendingItems = [];
      for (const entry of ledgerEntries) {
        const asgId = entry.assignment_id || entry.id;
        if (asgId) {
          pendingItems.push({
            itemId: asgId,
            courseId: entry.course_id,
            title: entry.title
          });
        }
      }
      for (const item of studentItems) {
        if (item.id && !pendingItems.some(p => p.itemId === item.id)) {
          pendingItems.push({
            itemId: item.id,
            courseId: item.course_id,
            title: item.title
          });
        }
      }

      let newFeedbackCount = 0;

      for (const item of pendingItems) {
        const relayUrl = courseRelayMap.get(item.courseId) || relayBaseUrl;
        if (!relayUrl) continue;

        // Try access codes for this course (or all access codes)
        const candidateCodes = new Set(accessCodesByCourse.get(item.courseId) || []);
        if (candidateCodes.size === 0) {
          // Fall back to all known access codes in profile
          for (const cls of Object.values(profile.classes || {})) {
            if (cls.access_code) candidateCodes.add(cls.access_code);
          }
        }

        for (const code of candidateCodes) {
          try {
            const fb = await FeedbackCapsule.fetchStudentRemoteFeedback(relayUrl, item.itemId, code);
            if (fb) {
              await StudentLedger.applyFeedback({
                itemId: item.itemId,
                courseId: item.courseId,
                title: item.title || fb.title,
                score: fb.points ?? fb.score,
                maxScore: fb.max_points ?? fb.total_points,
                feedback: fb.feedback || fb.overall_feedback || '',
                released_at: fb.reviewed_at || fb.released_at,
                source: 'relay_drop'
              });
              newFeedbackCount++;
              break;
            }
          } catch (_) {}
        }
      }

      return newFeedbackCount;
    } finally {
      this._running = false;
    }
  }
}

export const feedbackPoller = new RemoteFeedbackPoller();
