import { storage } from '../../core/storage.js';
import { generateUUID } from '../../utils/uuid.js';

/**
 * RubricStore: the one place that lists, saves, duplicates, detaches and deletes rubrics.
 *
 * A rubric belongs to a class (`course_id`) or is shared across classes (`course_id == null`).
 * Rubrics are referenced (by `rubric_id`) from:
 *   - tasks                   `grading.rubric_id`           (src/modules/tasks)
 *   - gradebook columns       `rubric_id`                   (gradebook_assignments)
 *   - assessments             `rubric_id` and `questions[].rubric_id` (src/modules/assignments)
 *   - video assessments       `checkpoints[].rubric_id`
 */

const TABLE = 'gradebook_rubrics';

const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''));

async function readAll(name) {
  try {
    return await storage.table(name).toArray();
  } catch (_) {
    return [];
  }
}

/** Every record that can reference a rubric, normalised to `{ kind, id, title, courseId, record, table }`. */
async function referencingItems() {
  const [tasks, columns, assessments, videos] = await Promise.all([
    readAll('tasks'),
    readAll('gradebook_assignments'),
    readAll('assignments'),
    readAll('video_assessments')
  ]);
  return {
    tasks: tasks.map(r => ({ kind: 'task', table: 'tasks', record: r, id: r.id, title: r.title || 'Untitled assignment', courseId: r.gradebook?.course_id || r.class_id || null })),
    columns: columns.map(r => ({ kind: 'column', table: 'gradebook_assignments', record: r, id: r.id, title: r.title || 'Gradebook column', courseId: r.course_id || null })),
    assessments: assessments.map(r => ({ kind: 'assessment', table: 'assignments', record: r, id: r.id, title: r.title || 'Untitled assessment', courseId: r.gradebook?.course_id || r.class_id || null })),
    videos: videos.map(r => ({ kind: 'video', table: 'video_assessments', record: r, id: r.id, title: r.title || 'Untitled video', courseId: r.gradebook?.course_id || r.class_id || null }))
  };
}

/** True when `record` references `rubricId` anywhere. */
function references(kind, record, rubricId) {
  if (kind === 'task') return record.grading?.rubric_id === rubricId;
  if (kind === 'column') return record.rubric_id === rubricId;
  if (kind === 'assessment') {
    return record.rubric_id === rubricId || (record.questions || []).some(q => q?.rubric_id === rubricId);
  }
  if (kind === 'video') {
    return record.rubric_id === rubricId || (record.checkpoints || []).some(cp => cp?.rubric_id === rubricId);
  }
  return false;
}

/** Clear every reference to `rubricId` inside `record` (mutates). Returns true when something changed. */
function clearReference(kind, record, rubricId) {
  let changed = false;
  if (kind === 'task') {
    if (record.grading?.rubric_id === rubricId) { record.grading.rubric_id = null; changed = true; }
  } else if (kind === 'column') {
    if (record.rubric_id === rubricId) { record.rubric_id = null; changed = true; }
  } else if (kind === 'assessment') {
    if (record.rubric_id === rubricId) { record.rubric_id = null; changed = true; }
    for (const q of record.questions || []) {
      if (q?.rubric_id === rubricId) { q.rubric_id = null; changed = true; }
    }
  } else if (kind === 'video') {
    if (record.rubric_id === rubricId) { record.rubric_id = null; changed = true; }
    for (const cp of record.checkpoints || []) {
      if (cp?.rubric_id === rubricId) { cp.rubric_id = null; changed = true; }
    }
  }
  return changed;
}

export class RubricStore {
  /** @returns {Promise<object[]>} every rubric, class rubrics first then shared, each sorted by title */
  static async listAll() {
    const all = await readAll(TABLE);
    const mine = all.filter(r => r.course_id).sort(byTitle);
    const shared = all.filter(r => !r.course_id).sort(byTitle);
    return [...mine, ...shared];
  }

  /**
   * Rubrics usable for a class: that class's own rubrics followed by the shared ones
   * (`course_id == null`). With no class only shared rubrics are returned.
   * This is the single query every editor uses.
   * @param {string|null} courseId
   * @returns {Promise<object[]>}
   */
  static async listFor(courseId) {
    const all = await readAll(TABLE);
    const mine = courseId ? all.filter(r => r.course_id === courseId).sort(byTitle) : [];
    const shared = all.filter(r => !r.course_id).sort(byTitle);
    return [...mine, ...shared];
  }

  /** Rubrics that belong to some other class (candidates for "Duplicate from another class"). */
  static async listFromOtherClasses(courseId) {
    const all = await readAll(TABLE);
    return all.filter(r => r.course_id && r.course_id !== (courseId || null)).sort(byTitle);
  }

  static async get(id) {
    if (!id) return null;
    try {
      return (await storage.table(TABLE).get(id)) || null;
    } catch (_) {
      return null;
    }
  }

  static async save(rubric) {
    await storage.table(TABLE).put(rubric);
    return rubric;
  }

  /**
   * Build (but do not save) a copy of a rubric for another class.
   * Inner tier/criterion ids are kept; they are only meaningful inside one rubric.
   */
  static duplicate(rubric, { courseId = undefined, title = undefined } = {}) {
    const copy = JSON.parse(JSON.stringify(rubric));
    copy.id = generateUUID();
    copy.course_id = courseId === undefined ? (rubric.course_id ?? null) : (courseId || null);
    copy.title = title ?? `${rubric.title || 'Rubric'} (copy)`;
    delete copy.created_at;
    delete copy.updated_at;
    return copy;
  }

  /**
   * Copy every rubric owned by `sourceCourseId` to `targetCourseId`.
   * @returns {Promise<Map<string,string>>} old rubric id -> new rubric id
   */
  static async cloneForCourse(sourceCourseId, targetCourseId) {
    const map = new Map();
    const rubrics = (await readAll(TABLE)).filter(r => r.course_id === sourceCourseId);
    for (const r of rubrics) {
      const copy = this.duplicate(r, { courseId: targetCourseId, title: r.title });
      await storage.table(TABLE).put(copy);
      map.set(r.id, copy.id);
    }
    return map;
  }

  /**
   * Rewrite `rubric_id` references on cloned records according to an old -> new map (mutates).
   * Understands tasks, columns, assessments (incl. per-question) and video checkpoints.
   * @returns {boolean} whether anything changed
   */
  static remapRefs(record, map) {
    if (!record || !map || map.size === 0) return false;
    let changed = false;
    const swap = (holder, key) => {
      const next = holder && map.get(holder[key]);
      if (next) { holder[key] = next; changed = true; }
    };
    swap(record, 'rubric_id');
    swap(record.grading, 'rubric_id');
    for (const q of record.questions || []) swap(q, 'rubric_id');
    for (const cp of record.checkpoints || []) swap(cp, 'rubric_id');
    return changed;
  }

  /**
   * Which items use this rubric?
   * @param {string} rubricId
   * @param {{ excludeCourseId?: string|null }} [opts] ignore items that belong to this class
   * @returns {Promise<{ count: number, items: Array<{kind:string,id:string,title:string,courseId:string|null}> }>}
   */
  static async usage(rubricId, { excludeCourseId = null } = {}) {
    const groups = await referencingItems();
    const items = [];
    for (const list of Object.values(groups)) {
      for (const it of list) {
        if (!references(it.kind, it.record, rubricId)) continue;
        if (excludeCourseId && it.courseId === excludeCourseId) continue;
        items.push({ kind: it.kind, id: it.id, title: it.title, courseId: it.courseId });
      }
    }
    return { count: items.length, items };
  }

  /** Clear `rubric_id` on every task, gradebook column, assessment and video that uses it. Returns the count detached. */
  static async detach(rubricId) {
    const groups = await referencingItems();
    let n = 0;
    for (const list of Object.values(groups)) {
      for (const it of list) {
        if (!references(it.kind, it.record, rubricId)) continue;
        clearReference(it.kind, it.record, rubricId);
        try {
          await storage.table(it.table).put(it.record);
          n++;
        } catch (_) { /* table unavailable */ }
      }
    }
    return n;
  }

  /** Delete a rubric, detaching it from everything that uses it first. */
  static async remove(rubricId, { detach = true } = {}) {
    let detached = 0;
    if (detach) detached = await this.detach(rubricId);
    await storage.table(TABLE).delete(rubricId);
    return { detached };
  }

  /**
   * Delete a class's rubrics. Those still referenced by something outside that class are kept and
   * converted to shared rubrics (`course_id = null`); the rest are removed.
   * @returns {Promise<{ deleted: string[], shared: string[] }>}
   */
  static async releaseForDeletedCourse(courseId) {
    const rubrics = (await readAll(TABLE)).filter(r => r.course_id === courseId);
    const deleted = [];
    const shared = [];
    for (const r of rubrics) {
      const { count } = await this.usage(r.id, { excludeCourseId: courseId });
      if (count > 0) {
        await storage.table(TABLE).put({ ...r, course_id: null });
        shared.push(r.id);
      } else {
        await storage.table(TABLE).delete(r.id);
        deleted.push(r.id);
      }
    }
    return { deleted, shared };
  }

  /** Short human label such as "3 criteria, 4 levels, 20 pts". */
  static describe(rubric) {
    const crit = (rubric?.criteria || []).length;
    const tiers = (rubric?.tiers || []).length;
    return `${crit} criteri${crit === 1 ? 'on' : 'a'}, ${tiers} level${tiers === 1 ? '' : 's'}`;
  }
}

export default RubricStore;
