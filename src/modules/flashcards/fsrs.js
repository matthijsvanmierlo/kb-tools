/**
 * Complete FSRS v4 Mathematical Spaced Repetition Engine (KB-CARD-002)
 */
export class FSRSEngine {
  constructor(customWeights = null, requestRetention = 0.90) {
    // Standard calibrated FSRS v4 default parameters
    this.w = customWeights || [
      0.4, 0.6, 2.4, 5.8, // w0..w3: Initial stability for Again(1), Hard(2), Good(3), Easy(4)
      4.93,               // w4: Initial difficulty base
      0.94,               // w5: Initial difficulty rating multiplier
      0.86,               // w6: Difficulty delta multiplier
      0.01,               // w7: Mean reversion weight
      1.49,               // w8: Stability recall multiplier
      0.14,               // w9: Stability power decay
      0.94,               // w10: Retrievability exponential factor
      2.18,               // w11: Post-lapse stability base
      0.05,               // w12: Post-lapse difficulty power
      0.34,               // w13: Post-lapse stability power
      1.26,               // w14: Post-lapse retrievability factor
      0.29,               // w15: Hard penalty multiplier
      2.61                // w16: Easy bonus multiplier
    ];

    this.requestRetention = requestRetention;
  }

  /**
   * Retrievability R(t, S) = (1 + (19/81) * (t / S)) ^ -0.5
   * @param {number} elapsedDays
   * @param {number} stability
   */
  calculateRetrievability(elapsedDays, stability) {
    if (stability <= 0) return 0;
    return Math.pow(1 + (19 / 81) * (elapsedDays / stability), -0.5);
  }

  /**
   * Next interval in days for target retention R = 0.90
   * @param {number} stability
   */
  nextInterval(stability) {
    const interval = (stability / (19 / 81)) * (Math.pow(this.requestRetention, -2) - 1);
    return Math.max(1, Math.round(interval));
  }

  /**
   * Grade a card: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
   * @param {object} card
   * @param {1 | 2 | 3 | 4} grade
   * @param {number} [nowMs=Date.now()]
   * @returns {object} updated FSRS state
   */
  reviewCard(card, grade, nowMs = Date.now()) {
    const w = this.w;
    const prev = card.fsrs || {
      state: 0,
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 0,
      last_review: null
    };

    const elapsedDays = prev.last_review
      ? Math.max(0, (nowMs - new Date(prev.last_review).getTime()) / 86400000)
      : 0;

    let S = prev.stability;
    let D = prev.difficulty;
    let reps = prev.reps;
    let lapses = prev.lapses;
    let state = prev.state;

    if (state === 0) {
      // First review of a New card
      S = w[grade - 1];
      D = Math.min(10, Math.max(1, w[4] - (grade - 3) * w[5]));
      state = grade === 1 ? 1 : 2;
      reps = grade === 1 ? 0 : 1;
    } else {
      // Subsequent review
      const R = this.calculateRetrievability(elapsedDays, S);
      const d0 = w[4];
      const nextD = D - w[6] * (grade - 3);
      D = Math.min(10, Math.max(1, w[7] * d0 + (1 - w[7]) * nextD));

      if (grade === 1) {
        // Lapse (Forgot)
        lapses += 1;
        reps = 0;
        state = 3; // Relearning
        S = Math.max(0.1, w[11] * Math.pow(D, -w[12]) * (Math.pow(S + 1, w[13]) - 1) * Math.exp(w[14] * (1 - R)));
      } else {
        // Recall success (Hard, Good, Easy)
        reps += 1;
        state = 2; // Review
        const hardPenalty = grade === 2 ? w[15] : 1;
        const easyBonus = grade === 4 ? w[16] : 1;
        const factor = Math.exp(w[8]) * (11 - D) * Math.pow(S, -w[9]) * (Math.exp(w[10] * (1 - R)) - 1) * hardPenalty * easyBonus;
        S = S * (1 + factor);
      }
    }

    const scheduledDays = grade === 1 ? 0 : this.nextInterval(S);

    // If Again (grade 1), schedule 10 minutes ahead in current session; else scheduledDays
    const dueTimestamp = grade === 1 ? nowMs + 600000 : nowMs + scheduledDays * 86400000;

    return {
      state,
      stability: Number(S.toFixed(4)),
      difficulty: Number(D.toFixed(4)),
      elapsed_days: Number(elapsedDays.toFixed(2)),
      scheduled_days: scheduledDays,
      reps,
      lapses,
      last_review: new Date(nowMs).toISOString(),
      due: new Date(dueTimestamp).toISOString(),
      due_timestamp: dueTimestamp
    };
  }

  /**
   * Sort queue by ascending retrievability (highest risk first)
   * @param {object[]} cards
   * @param {number} [nowMs=Date.now()]
   * @returns {object[]}
   */
  getDueCardsSorted(cards, nowMs = Date.now()) {
    if (!Array.isArray(cards)) return [];

    // Filter cards due now
    const dueCards = cards.filter(c => {
      if (!c.fsrs || !c.fsrs.due_timestamp) return true; // New cards are due
      return c.fsrs.due_timestamp <= nowMs;
    });

    // Compute retrievability R for each card and sort ascending
    return dueCards.sort((a, b) => {
      const getR = (card) => {
        if (!card.fsrs || card.fsrs.state === 0 || !card.fsrs.last_review) return 0; // New card = lowest R
        const elapsed = (nowMs - new Date(card.fsrs.last_review).getTime()) / 86400000;
        return this.calculateRetrievability(elapsed, card.fsrs.stability);
      };

      return getR(a) - getR(b);
    });
  }
}

export const fsrs = new FSRSEngine();
export default fsrs;
