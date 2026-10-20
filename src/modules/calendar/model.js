import { storage } from '../../core/storage.js';

/**
 * Calendar Model (KB-CAL-001)
 * Aggregates due dates and events across all lesson and gradebook modules,
 * and generates standard RFC 5545 iCalendar (.ics) exports.
 */

export async function loadCalendarEvents({ courseId = null, startDate = null, endDate = null } = {}) {
  const [courses, assignments, flashcards, timelines, videos, courseItems, gradebookAssignments, studentCourses, studentItems] = await Promise.all([
    storage.table('gradebook_courses').toArray().catch(() => []),
    storage.table('assignments').toArray().catch(() => []),
    storage.table('flashcards').toArray().catch(() => []),
    storage.table('timelines').toArray().catch(() => []),
    storage.table('video_assessments').toArray().catch(() => []),
    storage.table('course_items').toArray().catch(() => []),
    storage.table('gradebook_assignments').toArray().catch(() => []),
    storage.table('student_courses').toArray().catch(() => []),
    storage.table('student_items').toArray().catch(() => [])
  ]);

  const courseMap = new Map();
  for (const c of [...courses, ...studentCourses]) {
    if (!c?.id) continue;
    courseMap.set(c.id, {
      name: c.name || 'Untitled Class',
      color: c.color || '#2563eb',
      section: c.section || ''
    });
  }

  const events = [];
  const seenIds = new Set();

  // Helper to extract due info
  const addEvent = ({ id, kind, sourceId, title, date, time, cId, points, raw }) => {
    if (!date) return;
    const key = `${kind}:${sourceId || id}:${date}`;
    if (seenIds.has(key)) return;
    seenIds.add(key);

    const courseInfo = courseMap.get(cId) || { name: 'General', color: '#64748b', section: '' };

    events.push({
      id,
      kind,
      sourceId: sourceId || id,
      title: title || 'Untitled Event',
      date,
      time: time || null,
      courseId: cId || null,
      courseName: courseInfo.name,
      courseColor: courseInfo.color,
      points: points ?? 100,
      rawItem: raw
    });
  };

  // 1. Assignments
  for (const a of assignments) {
    const date = a.settings?.due_date || a.due_date;
    const time = a.settings?.due_time || a.due_time;
    addEvent({
      id: a.id,
      kind: 'assignment',
      sourceId: a.id,
      title: a.title,
      date,
      time,
      cId: a.course_id,
      points: a.total_points ?? 100,
      raw: a
    });
  }

  // 2. Flashcards
  for (const f of flashcards) {
    if (f.due_date) {
      addEvent({
        id: f.id,
        kind: 'flashcards',
        sourceId: f.id,
        title: f.title || f.name,
        date: f.due_date,
        time: f.due_time,
        cId: f.course_id,
        points: f.cards?.length || 10,
        raw: f
      });
    }
  }

  // 3. Timelines
  for (const t of timelines) {
    if (t.due_date) {
      addEvent({
        id: t.id,
        kind: 'timeline',
        sourceId: t.id,
        title: t.title,
        date: t.due_date,
        time: t.due_time,
        cId: t.course_id,
        points: t.events?.length || 10,
        raw: t
      });
    }
  }

  // 4. Video Assessments
  for (const v of videos) {
    const date = v.settings?.due_date || v.due_date;
    const time = v.settings?.due_time || v.due_time;
    if (date) {
      addEvent({
        id: v.id,
        kind: 'video',
        sourceId: v.id,
        title: v.title,
        date,
        time,
        cId: v.course_id,
        points: v.checkpoints?.length ? v.checkpoints.length * 10 : 100,
        raw: v
      });
    }
  }

  // 5. Course Items
  for (const ci of courseItems) {
    if (ci.due_date) {
      addEvent({
        id: ci.id,
        kind: ci.kind || 'course_item',
        sourceId: ci.source_id || ci.id,
        title: ci.title,
        date: ci.due_date,
        time: ci.due_time,
        cId: ci.course_id,
        points: ci.points,
        raw: ci
      });
    }
  }

  // 6. Gradebook Assignments (if not linked to an assignment above)
  for (const ga of gradebookAssignments) {
    if (ga.due_date) {
      const sourceId = ga.source?.id || ga.id;
      addEvent({
        id: ga.id,
        kind: ga.source?.type || 'assignment',
        sourceId,
        title: ga.title,
        date: ga.due_date,
        time: ga.due_time,
        cId: ga.course_id,
        points: ga.points_possible ?? 100,
        raw: ga
      });
    }
  }

  // 7. Student Items (enrolled coursework for student mode)
  for (const si of studentItems) {
    const date = si.due_date || si.payload?.due_date || si.payload?.settings?.due_date;
    const time = si.due_time || si.payload?.due_time || si.payload?.settings?.due_time;
    if (date) {
      addEvent({
        id: si.id,
        kind: si.kind || si.payload?.kind || 'assignment',
        sourceId: si.item_id || si.payload?.assignment_id || si.payload?.id || si.id,
        title: si.title || si.payload?.title || 'Course Item',
        date,
        time,
        cId: si.course_id,
        points: si.points || si.payload?.points || si.payload?.total_points || 100,
        raw: si
      });
    }
  }

  // Filter by courseId
  let filtered = events;
  if (courseId) {
    filtered = filtered.filter(e => e.courseId === courseId);
  }

  // Filter by date range
  if (startDate) {
    filtered = filtered.filter(e => e.date >= startDate);
  }
  if (endDate) {
    filtered = filtered.filter(e => e.date <= endDate);
  }

  // Sort chronologically
  filtered.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return a.title.localeCompare(b.title);
  });

  return filtered;
}

/**
 * Generate RFC 5545 iCalendar (.ics) format string
 */
export function generateIcsExport(events, { calendarName = 'KennisBoost Schedule' } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const dtStamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KennisBoost//LMS Calendar 1.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${calendarName}`
  ];

  for (const ev of events) {
    const dateClean = ev.date.replace(/-/g, '');
    let dtStart = '';
    let dtEnd = '';

    if (ev.time) {
      const timeClean = ev.time.replace(/:/g, '') + '00';
      dtStart = `DTSTART:${dateClean}T${timeClean}`;
      // default 1 hour duration
      const [h, m] = ev.time.split(':').map(Number);
      const endH = pad((h + 1) % 24);
      dtEnd = `DTEND:${dateClean}T${endH}${pad(m)}00`;
    } else {
      dtStart = `DTSTART;VALUE=DATE:${dateClean}`;
      dtEnd = `DTEND;VALUE=DATE:${dateClean}`;
    }

    const uid = `kb-${ev.kind}-${ev.sourceId}-${dateClean}@kennisboost.local`;
    const summary = `${ev.courseName ? `[${ev.courseName}] ` : ''}${ev.title}`;
    const desc = `Kind: ${ev.kind}\\nClass: ${ev.courseName}\\nPoints: ${ev.points}`;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtStamp}`,
      dtStart,
      dtEnd,
      `SUMMARY:${summary.replace(/,/g, '\\,')}`,
      `DESCRIPTION:${desc.replace(/,/g, '\\,')}`,
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
