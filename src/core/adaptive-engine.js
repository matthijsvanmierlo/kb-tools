/**
 * AdaptiveEngine - KB-ADAPTIVE-001
 *
 * Proposal #9: Prerequisites & Adaptive Mastery Progression Engine
 *
 * Evaluates client-side conditional unlocking of curriculum units and items
 * based on the student's personal gradebook ledger and mastery milestones.
 * Fully local-first; no server or telemetry round-trips.
 */

export class AdaptiveEngine {
  /**
   * Evaluate whether a student can access an item based on its prerequisite criteria.
   *
   * @param {object} item - The course item to evaluate
   * @param {Array<object>} ledger - All student_ledger records
   * @param {Array<object>} [allItems=[]] - All course items (used to resolve prerequisite titles)
   * @returns {{ unlocked: boolean, reason?: string, missingItemTitle?: string, currentScore?: number, requiredScore?: number }}
   */
  static evaluateItemAccess(item, ledger = [], allItems = []) {
    if (!item) return { unlocked: true };

    const prereqConfig = item.prerequisites || item.prereqs || null;
    const prereqIds = Array.isArray(prereqConfig?.item_ids)
      ? prereqConfig.item_ids
      : (Array.isArray(item.prerequisite_ids) ? item.prerequisite_ids : []);

    if (!prereqIds.length) {
      return { unlocked: true };
    }

    const minScore = Number(prereqConfig?.min_score ?? prereqConfig?.min_percent ?? 70);
    const minProficiency = prereqConfig?.min_proficiency || null;

    // Index ledger entries by assignment_id, item_id, and source_id
    const ledgerByItem = new Map();
    for (const entry of ledger) {
      if (entry.assignment_id) ledgerByItem.set(entry.assignment_id, entry);
      if (entry.item_id) ledgerByItem.set(entry.item_id, entry);
      if (entry.source_id) ledgerByItem.set(entry.source_id, entry);
    }

    const itemsById = new Map(allItems.map(it => [it.id, it]));

    for (const pid of prereqIds) {
      const entry = ledgerByItem.get(pid);
      const prereqItem = itemsById.get(pid);
      const title = prereqItem?.title || pid;

      if (!entry) {
        return {
          unlocked: false,
          reason: 'NOT_COMPLETED',
          missingItemTitle: title,
          missingItemId: pid,
          requiredScore: minScore
        };
      }

      // Check numeric score/percentage
      const score = Number(entry.percent ?? entry.points ?? entry.score ?? 0);
      if (score < minScore) {
        return {
          unlocked: false,
          reason: 'SCORE_INSUFFICIENT',
          missingItemTitle: title,
          missingItemId: pid,
          currentScore: score,
          requiredScore: minScore
        };
      }

      // Check proficiency tier if specified
      if (minProficiency && entry.proficiency) {
        const proficiencyRank = {
          'novice': 1,
          'developing': 2,
          'proficient': 3,
          'mastery': 4
        };
        const curRank = proficiencyRank[String(entry.proficiency).toLowerCase()] || 0;
        const reqRank = proficiencyRank[String(minProficiency).toLowerCase()] || 3;
        if (curRank < reqRank) {
          return {
            unlocked: false,
            reason: 'PROFICIENCY_INSUFFICIENT',
            missingItemTitle: title,
            missingItemId: pid,
            requiredProficiency: minProficiency
          };
        }
      }
    }

    return { unlocked: true };
  }

  /**
   * Filter and compute unlock statuses for an entire list of course items.
   *
   * @param {Array<object>} items
   * @param {Array<object>} ledger
   * @returns {Array<object & { access: object }>}
   */
  static annotateCourseItems(items = [], ledger = []) {
    return items.map(it => ({
      ...it,
      access: this.evaluateItemAccess(it, ledger, items)
    }));
  }

  /**
   * Calculate student course progress percentage based on completed unlocked items.
   *
   * @param {Array<object>} items
   * @param {Array<object>} ledger
   * @returns {{ total: number, completed: number, percent: number }}
   */
  static calculateCourseProgress(items = [], ledger = []) {
    if (!items.length) return { total: 0, completed: 0, percent: 100 };

    const ledgerIds = new Set(
      ledger.map(e => e.assignment_id || e.item_id || e.source_id).filter(Boolean)
    );

    let completed = 0;
    for (const it of items) {
      if (ledgerIds.has(it.id) || ledgerIds.has(it.source_id)) {
        completed++;
      }
    }

    return {
      total: items.length,
      completed,
      percent: Math.round((completed / items.length) * 100)
    };
  }
}

export default AdaptiveEngine;
