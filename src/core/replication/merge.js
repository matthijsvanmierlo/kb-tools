/**
 * Smart Record & Array Merging for Multi-Device Offline Replication
 */

export function mergeRecords(table, local, incoming, sourceDevice, localDevice, incomingWins) {
  if (!local) return incoming;
  if (!incoming) return local;

  // 1. Flashcards: Merge cards array by card.id, merging FSRS states independently
  if (table === 'flashcards' && Array.isArray(local.cards) && Array.isArray(incoming.cards)) {
    const cardMap = new Map();
    for (const c of local.cards) {
      if (c && c.id) cardMap.set(c.id, { ...c });
    }
    for (const incCard of incoming.cards) {
      if (!incCard || !incCard.id) continue;
      const existing = cardMap.get(incCard.id);
      if (!existing) {
        cardMap.set(incCard.id, { ...incCard });
      } else {
        // Compare updated_at or card level edits
        const incTime = incCard.updated_at || incoming.updated_at || '';
        const exTime = existing.updated_at || local.updated_at || '';
        const baseCard = (incTime > exTime || (incTime === exTime && sourceDevice > localDevice)) ? { ...existing, ...incCard } : { ...incCard, ...existing };

        // Smart FSRS merge: pick FSRS with newer last_review, or higher reps
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
    const mergedDeck = incomingWins ? { ...local, ...incoming } : { ...incoming, ...local };
    mergedDeck.cards = Array.from(cardMap.values());
    return mergedDeck;
  }

  // 2. Gradebook Courses: Separate feed state from course settings
  if (table === 'gradebook_courses') {
    const winner = incomingWins ? incoming : local;
    const loser = incomingWins ? local : incoming;
    
    // Pick newer feed state independently
    const localFeedTime = local.feed?.dirty_at || local.feed?.published_at || '';
    const incFeedTime = incoming.feed?.dirty_at || incoming.feed?.published_at || '';
    const bestFeed = (incFeedTime > localFeedTime) ? incoming.feed : (local.feed || incoming.feed);

    return {
      ...loser,
      ...winner,
      feed: bestFeed
    };
  }

  // 3. Timelines: Merge events array by id
  if (table === 'timelines' && Array.isArray(local.events) && Array.isArray(incoming.events)) {
    const evMap = new Map();
    for (const ev of local.events) if (ev?.id) evMap.set(ev.id, ev);
    for (const ev of incoming.events) {
      if (!ev?.id) continue;
      const existing = evMap.get(ev.id);
      if (!existing || incomingWins) evMap.set(ev.id, ev);
    }
    const res = incomingWins ? { ...local, ...incoming } : { ...incoming, ...local };
    res.events = Array.from(evMap.values());
    return res;
  }

  // 4. Assignments: Merge questions array by id
  if (table === 'assignments' && Array.isArray(local.questions) && Array.isArray(incoming.questions)) {
    const qMap = new Map();
    for (const q of local.questions) if (q?.id) qMap.set(q.id, q);
    for (const q of incoming.questions) {
      if (!q?.id) continue;
      const existing = qMap.get(q.id);
      if (!existing || incomingWins) qMap.set(q.id, q);
    }
    const res = incomingWins ? { ...local, ...incoming } : { ...incoming, ...local };
    res.questions = Array.from(qMap.values());
    return res;
  }

  // 5. Default fallback to incomingWins winner
  return incomingWins ? incoming : local;
}
