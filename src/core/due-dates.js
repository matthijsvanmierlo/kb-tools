import { storage } from './storage.js';

/**
 * Unified Due Dates Manager (KB-CORE-DUE)
 * Single source of truth for due dates across assignments, videos, flashcards, timelines, and course items.
 */

export async function getDue(kind, id) {
  if (!id) return { date: null, time: null };

  try {
    if (kind === 'assignment') {
      const a = await storage.table('assignments').get(id);
      return {
        date: a?.settings?.due_date || null,
        time: a?.settings?.due_time || null
      };
    }
    if (kind === 'task') {
      const t = await storage.table('tasks').get(id);
      return {
        date: t?.due_date || t?.settings?.due_date || null,
        time: t?.due_time || t?.settings?.due_time || null
      };
    }
    if (kind === 'video') {
      const v = await storage.table('video_assessments').get(id);
      return {
        date: v?.settings?.due_date || null,
        time: v?.settings?.due_time || null
      };
    }
    if (kind === 'flashcards') {
      const f = await storage.table('flashcards').get(id);
      return {
        date: f?.due_date || null,
        time: f?.due_time || null
      };
    }
    if (kind === 'timeline') {
      const t = await storage.table('timelines').get(id);
      return {
        date: t?.due_date || null,
        time: t?.due_time || null
      };
    }
    if (kind === 'course_item') {
      const ci = await storage.table('course_items').get(id);
      return {
        date: ci?.due_date || null,
        time: ci?.due_time || null
      };
    }
  } catch (err) {
    console.warn(`[due-dates] Error fetching due date for ${kind}:${id}`, err);
  }

  return { date: null, time: null };
}

export async function setDue(kind, id, { date = null, time = null } = {}) {
  if (!id) return;

  const normalizedDate = date && String(date).trim() ? String(date).trim() : null;
  const normalizedTime = time && String(time).trim() ? String(time).trim() : null;
  const now = new Date().toISOString();

  try {
    let linkedClassId = null;

    if (kind === 'assignment') {
      const a = await storage.table('assignments').get(id);
      if (a) {
        a.settings = a.settings || {};
        a.settings.due_date = normalizedDate;
        a.settings.due_time = normalizedTime;
        a.updated_at = now;
        await storage.table('assignments').put(a);
        linkedClassId = a.gradebook?.course_id || a.class_id || null;
      }
    } else if (kind === 'task') {
      const t = await storage.table('tasks').get(id);
      if (t) {
        t.due_date = normalizedDate;
        t.due_time = normalizedTime;
        t.settings = t.settings || {};
        t.settings.due_date = normalizedDate;
        t.settings.due_time = normalizedTime;
        t.updated_at = now;
        await storage.table('tasks').put(t);
        linkedClassId = t.class_id || t.gradebook?.course_id || null;
      }
    } else if (kind === 'video') {
      const v = await storage.table('video_assessments').get(id);
      if (v) {
        v.settings = v.settings || {};
        v.settings.due_date = normalizedDate;
        v.settings.due_time = normalizedTime;
        v.updated_at = now;
        await storage.table('video_assessments').put(v);
        linkedClassId = v.gradebook?.course_id || v.class_id || null;
      }
    } else if (kind === 'flashcards') {
      const f = await storage.table('flashcards').get(id);
      if (f) {
        f.due_date = normalizedDate;
        f.due_time = normalizedTime;
        f.updated_at = now;
        await storage.table('flashcards').put(f);
        linkedClassId = f.class_id || null;
      }
    } else if (kind === 'timeline') {
      const t = await storage.table('timelines').get(id);
      if (t) {
        t.due_date = normalizedDate;
        t.due_time = normalizedTime;
        t.updated_at = now;
        await storage.table('timelines').put(t);
        linkedClassId = t.class_id || null;
      }
    } else if (kind === 'course_item') {
      const ci = await storage.table('course_items').get(id);
      if (ci) {
        ci.due_date = normalizedDate;
        ci.due_time = normalizedTime;
        ci.updated_at = now;
        await storage.table('course_items').put(ci);
        linkedClassId = ci.course_id || null;
      }
    }

    // Synchronize linked gradebook assignment if exists
    try {
      const srcType = kind === 'video' ? 'video' : (kind === 'assignment' ? 'assignment' : (kind === 'task' ? 'task' : kind));
      const cols = await storage.table('gradebook_assignments').toArray();
      const linked = cols.filter(c => (c.source?.type === srcType && c.source?.id === id) || (kind === 'assignment' && c.id === id));
      for (const col of linked) {
        col.due_date = normalizedDate;
        col.updated_at = now;
        await storage.table('gradebook_assignments').put(col);
      }
    } catch (_) {}

    // Synchronize course_items referencing this item
    try {
      const cItems = await storage.table('course_items').toArray();
      const matchingCItems = cItems.filter(item => item.ref_id === id && (item.kind === kind || (kind === 'assignment' && item.kind === 'assignments') || (kind === 'task' && item.kind === 'tasks')));
      for (const item of matchingCItems) {
        item.due_date = normalizedDate;
        item.due_time = normalizedTime;
        item.updated_at = now;
        await storage.table('course_items').put(item);
      }
    } catch (_) {}

    // Mark course feed dirty if linked to a course
    if (linkedClassId) {
      try {
        const { markCourseFeedDirty } = await import('./course-revision.js');
        await markCourseFeedDirty(linkedClassId);
      } catch (_) {}
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kb-due-dates-changed', {
        detail: { kind, id, date: normalizedDate, time: normalizedTime }
      }));
    }
  } catch (err) {
    console.error(`[due-dates] Error updating due date for ${kind}:${id}`, err);
    throw err;
  }
}
