/**
 * Advanced Gradebook Calculation Engines (KB-GRAD-001 & KB-GRAD-002)
 * Supports Traditional Weighted, Decaying Average, Marzano Power Law, Highest Score, Trend Mode,
 * and penalty normalization for Missing, Late, and Exempt work.
 */

/**
 * Assignment Status & Penalty Normalizer
 * @param {object} gradeRecord - { raw_score, status, days_late }
 * @param {object} assignment - { max_score }
 * @param {object} [policy={}] - { missing_floor_pct, late_mode, late_deduct_pct, late_daily_pct, max_late_cap_pct, minimum_grade_pct }
 * @returns {{ effectivePct: number, effectivePoints: number, maxPoints: number } | null}
 */
export function normalizeScore(gradeRecord, assignment, policy = {}) {
  if (!gradeRecord || gradeRecord.status === 'exempt' || gradeRecord.raw_score === null || gradeRecord.raw_score === undefined) {
    if (gradeRecord && gradeRecord.status === 'missing') {
      const floorPct = policy.missing_floor_pct ?? 0; // e.g. 50% minimum grading or 0%
      return {
        effectivePct: floorPct,
        effectivePoints: (floorPct / 100) * assignment.max_score,
        maxPoints: assignment.max_score
      };
    }
    return null; // Excluded from calculation
  }

  if (gradeRecord.status === 'missing') {
    const floorPct = policy.missing_floor_pct ?? 0;
    return {
      effectivePct: floorPct,
      effectivePoints: (floorPct / 100) * assignment.max_score,
      maxPoints: assignment.max_score
    };
  }

  let pct = (gradeRecord.raw_score / assignment.max_score) * 100;

  if (gradeRecord.status === 'late') {
    if (policy.late_mode === 'fixed') {
      pct = Math.max(policy.minimum_grade_pct || 0, pct - (policy.late_deduct_pct || 0));
    } else if (policy.late_mode === 'daily') {
      const days = Math.max(1, gradeRecord.days_late || 1);
      const totalPenalty = Math.min(policy.max_late_cap_pct || 50, days * (policy.late_daily_pct || 0));
      pct = Math.max(policy.minimum_grade_pct || 0, pct - totalPenalty);
    }
  }

  return {
    effectivePct: pct,
    effectivePoints: (pct / 100) * assignment.max_score,
    maxPoints: assignment.max_score
  };
}

/**
 * Mathematical Grade Calculation Engine
 */
export class GradebookMathEngine {
  /**
   * 1. Traditional Weighted Categories with "Drop Lowest N"
   * Grade = sum( CategoryAvg_k * CategoryWeight_k ) / sum( ActiveCategoryWeights )
   * @param {Map<string, object>} records - assignment_id -> gradeRecord
   * @param {any[]} assignments
   * @param {any[]} categories
   * @returns {number|null}
   */
  static computeTraditionalWeighted(records, assignments, categories) {
    let weightedSum = 0;
    let activeWeightTotal = 0;

    for (const cat of categories) {
      const catItems = assignments
        .filter(a => a.category_id === cat.id)
        .map(a => normalizeScore(records.get ? records.get(a.id) : records[a.id], a, cat.policy || {}))
        .filter(norm => norm !== null);

      if (catItems.length === 0) continue;

      // Drop lowest N scores if cat.drop_lowest > 0 and enough items exist
      let keptItems = [...catItems];
      if (cat.drop_lowest > 0 && keptItems.length > cat.drop_lowest) {
        keptItems.sort((a, b) => a.effectivePct - b.effectivePct);
        keptItems = keptItems.slice(cat.drop_lowest);
      }

      const earned = keptItems.reduce((sum, item) => sum + item.effectivePoints, 0);
      const possible = keptItems.reduce((sum, item) => sum + item.maxPoints, 0);

      if (possible > 0) {
        const catPct = (earned / possible) * 100;
        const weightFrac = (cat.weight_pct || 0) / 100;
        weightedSum += catPct * weightFrac;
        activeWeightTotal += weightFrac;
      }
    }

    return activeWeightTotal > 0 ? Number((weightedSum / activeWeightTotal).toFixed(2)) : null;
  }

  /**
   * 2. SBG: Decaying Average (Prioritizes recent mastery)
   * M_n = M_{n-1} * (1 - alpha) + S_n * alpha (Default alpha = 0.65)
   * Chronological order: S_1 .. S_n
   * @param {number[]} chronologicalMasteryScores
   * @param {number} [alpha=0.65]
   * @returns {number|null}
   */
  static computeDecayingAverage(chronologicalMasteryScores, alpha = 0.65) {
    if (!chronologicalMasteryScores || chronologicalMasteryScores.length === 0) return null;
    let currentMastery = chronologicalMasteryScores[0];

    for (let i = 1; i < chronologicalMasteryScores.length; i++) {
      currentMastery = currentMastery * (1 - alpha) + chronologicalMasteryScores[i] * alpha;
    }
    return Number(currentMastery.toFixed(2));
  }

  /**
   * 3. SBG: Marzano Power Law (Predicts current mastery trajectory via Log-Log OLS Regression)
   * Model: S_t = a * (t ^ b) ==> ln(S_t) = ln(a) + b * ln(t)
   * where t = 1, 2, ..., n and S_t > 0
   * @param {number[]} chronologicalMasteryScores
   * @returns {number|null}
   */
  static computeMarzanoPowerLaw(chronologicalMasteryScores) {
    const n = chronologicalMasteryScores ? chronologicalMasteryScores.length : 0;
    if (n === 0) return null;
    if (n === 1) return chronologicalMasteryScores[0];

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i + 1;
      const s = Math.max(0.1, chronologicalMasteryScores[i]); // Guard ln(0)
      const x = Math.log(t);
      const y = Math.log(s);
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }

    const denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 1e-9) return chronologicalMasteryScores[n - 1];

    const b = (n * sumXY - sumX * sumY) / denom;
    const lnA = (sumY - b * sumX) / n;
    const a = Math.exp(lnA);

    // Evaluate predicted score at current assessment index t = n, clamped to [1.0, 4.0]
    const predicted = a * Math.pow(n, b);
    return Number(Math.min(4.0, Math.max(1.0, predicted)).toFixed(2));
  }

  /**
   * 4. SBG: Highest Score
   * @param {number[]} scores
   * @returns {number|null}
   */
  static computeHighestScore(scores) {
    return scores && scores.length > 0 ? Math.max(...scores) : null;
  }

  /**
   * 5. SBG: Trend Mode (Tie-breaker biased toward latest occurrences)
   * @param {number[]} chronologicalScores
   * @returns {number|null}
   */
  static computeTrendMode(chronologicalScores) {
    if (!chronologicalScores || chronologicalScores.length === 0) return null;
    const freqMap = new Map();
    const lastIndexMap = new Map();

    chronologicalScores.forEach((score, idx) => {
      const rounded = Math.round(score * 2) / 2; // Bucket by 0.5 increments
      freqMap.set(rounded, (freqMap.get(rounded) || 0) + 1);
      lastIndexMap.set(rounded, idx);
    });

    let bestScore = chronologicalScores[chronologicalScores.length - 1];
    let maxFreq = -1;
    let latestIdx = -1;

    for (const [scoreVal, count] of freqMap.entries()) {
      const lastIdx = lastIndexMap.get(scoreVal);
      if (count > maxFreq || (count === maxFreq && lastIdx > latestIdx)) {
        maxFreq = count;
        latestIdx = lastIdx;
        bestScore = scoreVal;
      }
    }
    return bestScore;
  }

  /**
   * SBG-to-Traditional Institutional Conversion Matrix
   * Maps 1.00 - 4.00 to letter grade and institutional percentage
   * @param {number} masteryScore
   * @returns {{ percent: number, letter: string }}
   */
  static masteryToGrade(masteryScore) {
    if (masteryScore === null || masteryScore === undefined) {
      return { percent: 0, letter: 'N/A' };
    }
    if (masteryScore >= 3.50) return { percent: 95, letter: 'A' };
    if (masteryScore >= 3.00) return { percent: 88, letter: 'B+' };
    if (masteryScore >= 2.50) return { percent: 82, letter: 'B-' };
    if (masteryScore >= 2.00) return { percent: 75, letter: 'C' };
    if (masteryScore >= 1.50) return { percent: 65, letter: 'D' };
    return { percent: 55, letter: 'F' };
  }

  /**
   * Percentage to Letter Grade (Traditional scale)
   */
  static percentageToLetter(pct) {
    if (pct === null || pct === undefined) return 'N/A';
    if (pct >= 93) return 'A';
    if (pct >= 90) return 'A-';
    if (pct >= 87) return 'B+';
    if (pct >= 83) return 'B';
    if (pct >= 80) return 'B-';
    if (pct >= 77) return 'C+';
    if (pct >= 73) return 'C';
    if (pct >= 70) return 'C-';
    if (pct >= 67) return 'D+';
    if (pct >= 60) return 'D';
    return 'F';
  }
}

export default GradebookMathEngine;
