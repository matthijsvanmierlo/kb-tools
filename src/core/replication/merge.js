import { HLC, compareStamp } from './hlc.js';

/**
 * Marks items in an array as removed, recording their deletion in _removed: { [id]: hlc }
 * so deletes can be reliably merged across devices.
 *
 * @param {object} record
 * @param {string} arrayName
 * @param {string[]} ids
 * @param {string} [hlcStamp]
 * @returns {object} The mutated record
 */
export function markRemoved(record, arrayName, ids = [], hlcStamp = null) {
  if (!record) return record;
  if (!record._removed || typeof record._removed !== 'object') {
    record._removed = {};
  }
  const stamp = hlcStamp || record._hlc || new Date().toISOString();
  for (const id of ids) {
    if (id) record._removed[id] = stamp;
  }
  if (Array.isArray(record[arrayName])) {
    const removeSet = new Set(ids);
    record[arrayName] = record[arrayName].filter(item => !removeSet.has(item?.id));
  }
  return record;
}

/**
 * Smart Record & Array Merging for Multi-Device Offline Replication
 */
export function mergeRecords(table, local, incoming, sourceDevice, localDevice, incomingWins) {
  if (!local) return incoming;
  if (!incoming) return local;

  // Combine parent tombstone / removal tracking
  const mergedRemoved = {
    ...(local._removed || {}),
    ...(incoming._removed || {})
  };

  // 1. Gradebook Grades: Field-level merge (score, rubric_eval, comments, status)
  if (table === 'gradebook_grades') {
    const fields = ['score', 'rubric_eval', 'comments', 'status'];
    const localFhlc = local._fhlc || {};
    const incFhlc = incoming._fhlc || {};
    const mergedFhlc = { ...localFhlc, ...incFhlc };
    const merged = incomingWins ? { ...local, ...incoming, _fhlc: mergedFhlc } : { ...incoming, ...local, _fhlc: mergedFhlc };

    for (const f of fields) {
      const lVal = local[f];
      const iVal = incoming[f];
      const hasLocalF = Boolean(localFhlc && localFhlc[f]);
      const hasIncF = Boolean(incFhlc && incFhlc[f]);

      if (hasLocalF && !hasIncF) {
        merged[f] = lVal;
        mergedFhlc[f] = localFhlc[f];
      } else if (!hasLocalF && hasIncF) {
        merged[f] = iVal;
        mergedFhlc[f] = incFhlc[f];
      } else if (hasLocalF && hasIncF) {
        if (HLC.compare(localFhlc[f], incFhlc[f]) >= 0) {
          merged[f] = lVal;
          mergedFhlc[f] = localFhlc[f];
        } else {
          merged[f] = iVal;
          mergedFhlc[f] = incFhlc[f];
        }
      } else {
        if (incomingWins) {
          merged[f] = iVal !== undefined ? iVal : lVal;
        } else {
          merged[f] = lVal !== undefined ? lVal : iVal;
        }
      }
    }

    merged._hlc = HLC.compare(incoming._hlc, local._hlc) > 0 ? incoming._hlc : local._hlc;
    return merged;
  }

  // 2. Flashcards: Merge cards array by card.id, respecting _removed and FSRS state
  if (table === 'flashcards' && Array.isArray(local.cards) && Array.isArray(incoming.cards)) {
    const cardMap = new Map();
    // Index local cards
    for (const c of local.cards) {
      if (!c?.id) continue;
      cardMap.set(c.id, { ...c });
    }

    // Merge incoming cards
    for (const incCard of incoming.cards) {
      if (!incCard?.id) continue;
      const existing = cardMap.get(incCard.id);
      if (!existing) {
        cardMap.set(incCard.id, { ...incCard });
      } else {
        const incHlc = incCard._hlc || incoming._hlc || incCard.updated_at || incoming.updated_at || '';
        const exHlc = existing._hlc || local._hlc || existing.updated_at || local.updated_at || '';
        const baseCard = (HLC.compare(incHlc, exHlc) > 0 || (incHlc === exHlc && sourceDevice > localDevice))
          ? { ...existing, ...incCard }
          : { ...incCard, ...existing };

        // FSRS merge: newer last_review or higher reps
        if (existing.fsrs || incCard.fsrs) {
          const exFsrs = existing.fsrs;
          const incFsrs = incCard.fsrs;
          if (!exFsrs) baseCard.fsrs = incFsrs;
          else if (!incFsrs) baseCard.fsrs = exFsrs;
          else {
            const exReview = exFsrs.last_review || '';
            const incReview = incFsrs.last_review || '';
            if (incReview > exReview) baseCard.fsrs = incFsrs;
            else if (exReview > incReview) baseCard.fsrs = exFsrs;
            else baseCard.fsrs = (incFsrs.reps || 0) >= (exFsrs.reps || 0) ? incFsrs : exFsrs;
          }
        }
        cardMap.set(incCard.id, baseCard);
      }
    }

    // Filter out removed cards whose removal HLC is newer than card HLC
    const finalCards = [];
    for (const [id, card] of cardMap.entries()) {
      const removedHlc = mergedRemoved[id];
      const cardHlc = card._hlc || card.updated_at || '';
      if (removedHlc && HLC.compare(removedHlc, cardHlc) >= 0) {
        // Element was deleted after or concurrently with edit
        continue;
      }
      finalCards.push(card);
    }

    const mergedDeck = incomingWins ? { ...local, ...incoming } : { ...incoming, ...local };
    mergedDeck.cards = finalCards;
    mergedDeck._removed = mergedRemoved;
    mergedDeck._hlc = HLC.compare(incoming._hlc, local._hlc) > 0 ? incoming._hlc : local._hlc;
    return mergedDeck;
  }

  // 3. Timelines: Merge events array by id
  if (table === 'timelines' && Array.isArray(local.events) && Array.isArray(incoming.events)) {
    const evMap = new Map();
    for (const ev of local.events) if (ev?.id) evMap.set(ev.id, { ...ev });
    for (const incEv of incoming.events) {
      if (!incEv?.id) continue;
      const existing = evMap.get(incEv.id);
      if (!existing) {
        evMap.set(incEv.id, { ...incEv });
      } else {
        const incHlc = incEv._hlc || incoming._hlc || '';
        const exHlc = existing._hlc || local._hlc || '';
        const winner = HLC.compare(incHlc, exHlc) > 0 ? incEv : existing;
        evMap.set(incEv.id, { ...existing, ...winner });
      }
    }

    const finalEvents = [];
    for (const [id, ev] of evMap.entries()) {
      const removedHlc = mergedRemoved[id];
      const evHlc = ev._hlc || '';
      if (removedHlc && HLC.compare(removedHlc, evHlc) >= 0) continue;
      finalEvents.push(ev);
    }

    const res = incomingWins ? { ...local, ...incoming } : { ...incoming, ...local };
    res.events = finalEvents;
    res._removed = mergedRemoved;
    res._hlc = HLC.compare(incoming._hlc, local._hlc) > 0 ? incoming._hlc : local._hlc;
    return res;
  }

  // 4. Assignments: Merge questions array by id
  if (table === 'assignments' && Array.isArray(local.questions) && Array.isArray(incoming.questions)) {
    const qMap = new Map();
    for (const q of local.questions) if (q?.id) qMap.set(q.id, { ...q });
    for (const incQ of incoming.questions) {
      if (!incQ?.id) continue;
      const existing = qMap.get(incQ.id);
      if (!existing) {
        qMap.set(incQ.id, { ...incQ });
      } else {
        const incHlc = incQ._hlc || incoming._hlc || '';
        const exHlc = existing._hlc || local._hlc || '';
        const winner = HLC.compare(incHlc, exHlc) > 0 ? incQ : existing;
        qMap.set(incQ.id, { ...existing, ...winner });
      }
    }

    const finalQuestions = [];
    for (const [id, q] of qMap.entries()) {
      const removedHlc = mergedRemoved[id];
      const qHlc = q._hlc || '';
      if (removedHlc && HLC.compare(removedHlc, qHlc) >= 0) continue;
      finalQuestions.push(q);
    }

    const res = incomingWins ? { ...local, ...incoming } : { ...incoming, ...local };
    res.questions = finalQuestions;
    res._removed = mergedRemoved;
    res._hlc = HLC.compare(incoming._hlc, local._hlc) > 0 ? incoming._hlc : local._hlc;
    return res;
  }

  // 5. Gradebook Courses: Feed state and course settings
  if (table === 'gradebook_courses') {
    const winner = incomingWins ? incoming : local;
    const loser = incomingWins ? local : incoming;

    const localFeedHlc = local.feed?._hlc || local.feed?.dirty_since || local.feed?.last_published || '';
    const incFeedHlc = incoming.feed?._hlc || incoming.feed?.dirty_since || incoming.feed?.last_published || '';
    const bestFeed = HLC.compare(incFeedHlc, localFeedHlc) > 0 ? incoming.feed : (local.feed || incoming.feed);

    const res = {
      ...loser,
      ...winner,
      _hlc: HLC.compare(incoming._hlc, local._hlc) > 0 ? incoming._hlc : local._hlc
    };
    if (bestFeed !== undefined) {
      res.feed = bestFeed;
    } else {
      delete res.feed;
    }
    return res;
  }

  // 6. Default fallback
  const res = incomingWins ? incoming : local;
  return res;
}
