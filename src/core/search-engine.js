/**
 * SearchEngine Coordinator (KB-SEARCH-002)
 * Connects Web Worker BM25 inverted index to Dexie IndexedDB and real-time storage mutations.
 * Includes in-memory fallback for test environments without Worker support.
 */

import { storage } from './storage.js';

export class SearchEngine {
  static _worker = null;
  static _initialized = false;
  static _initPromise = null;
  static _pendingQueries = new Map();
  static _queryCounter = 0;
  static _fallbackIndex = null;
  static _backlinks = new Map(); // targetKey -> Set<sourceId>

  static async init() {
    if (this._initialized) return this;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      // 1. Initialize Worker or fallback
      if (typeof Worker !== 'undefined') {
        try {
          this._worker = new Worker(new URL('./search-worker.js', import.meta.url), { type: 'module' });
          this._worker.onmessage = (e) => this._handleWorkerMessage(e.data);
        } catch (err) {
          console.warn('[SearchEngine] Worker spawn failed, using in-memory engine:', err);
          this._fallbackIndex = new Map();
        }
      } else {
        this._fallbackIndex = new Map();
      }

      // 2. Load all searchable data from Dexie
      const docs = await this._collectAllDocuments();

      if (this._worker) {
        this._worker.postMessage({ type: 'INDEX_INIT', payload: docs });
      } else {
        for (const d of docs) {
          this._fallbackIndex.set(d.id, d);
        }
      }

      // 3. Listen to mutations for live updates
      storage.onMutation(({ tableName, action, key, obj }) => {
        this._handleStorageMutation(tableName, action, key, obj);
      });

      this._initialized = true;
      return this;
    })();

    return this._initPromise;
  }

  static _handleWorkerMessage(data) {
    const { type, results, correlationId } = data || {};
    if (type === 'SEARCH_RESULTS' && correlationId !== undefined) {
      const resolver = this._pendingQueries.get(correlationId);
      if (resolver) {
        this._pendingQueries.delete(correlationId);
        resolver(results);
      }
    }
  }

  static async _collectAllDocuments() {
    const docs = [];

    // Helper to push document
    const push = (doc) => {
      if (doc && doc.id) {
        docs.push(doc);
        this._scanForWikilinks(doc.id, doc.body || '');
      }
    };

    try {
      // 1. Courses / Classes
      const courses = await storage.table('gradebook_courses').toArray().catch(() => []);
      for (const c of courses) {
        push({
          id: `course_${c.id}`,
          classId: c.id,
          type: 'course',
          category: 'Classes',
          title: c.name || 'Untitled Class',
          body: `${c.section || ''} ${c.academic_year || ''} ${c.description || ''}`,
          route: `#/classes?courseId=${c.id}`
        });
      }

      // 2. Course Units & Items
      const [units, items] = await Promise.all([
        storage.table('course_units').toArray().catch(() => []),
        storage.table('course_items').toArray().catch(() => [])
      ]);
      for (const u of units) {
        push({
          id: `unit_${u.id}`,
          classId: u.course_id || null,
          type: 'unit',
          category: 'Curriculum Units',
          title: u.title || 'Untitled Unit',
          body: u.description || '',
          route: `#/course?id=${u.course_id}`
        });
      }
      for (const it of items) {
        push({
          id: `item_${it.id}`,
          classId: it.course_id || null,
          type: 'item',
          category: 'Course Content',
          title: it.title || 'Untitled Item',
          body: `${it.description || ''} ${it.kind || ''}`,
          route: `#/course?id=${it.course_id}`
        });
      }

      // 3. Flashcard Decks
      const decks = await storage.table('flashcards').toArray().catch(() => []);
      for (const d of decks) {
        const cardsText = (d.cards || []).map(c => {
          const front = typeof c.front === 'string' ? c.front : (c.front?.text || '');
          const back = typeof c.back === 'string' ? c.back : (c.back?.text || '');
          return `${front} ${back}`;
        }).join(' ');

        push({
          id: `fc_${d.id}`,
          classId: d.class_id || null,
          type: 'flashcards',
          category: 'Flashcards',
          title: d.title || 'Untitled Deck',
          body: `${d.description || ''} ${cardsText}`,
          route: `#/flashcards/study?id=${d.id}`
        });
      }

      // 4. Timelines
      const timelines = await storage.table('timelines').toArray().catch(() => []);
      for (const t of timelines) {
        const eventsText = (t.events || []).map(e => `${e.title || ''} ${e.description || ''}`).join(' ');
        push({
          id: `tl_${t.id}`,
          classId: t.class_id || null,
          type: 'timeline',
          category: 'Timelines',
          title: t.title || 'Untitled Timeline',
          body: `${t.description || ''} ${eventsText}`,
          route: `#/timeline/view?id=${t.id}`
        });
      }

      // 5. Video Assessments
      const videos = await storage.table('video_assessments').toArray().catch(() => []);
      for (const v of videos) {
        const cpText = (v.checkpoints || []).map(cp => `${cp.question || ''} ${(cp.options || []).join(' ')}`).join(' ');
        push({
          id: `vid_${v.id}`,
          classId: v.class_id || null,
          type: 'video',
          category: 'Video Lessons',
          title: v.title || 'Untitled Video Lesson',
          body: `${v.description || ''} ${cpText}`,
          route: `#/video/kiosk?id=${v.id}`
        });
      }

      // 6. Assessments
      const assessments = await storage.table('assignments').toArray().catch(() => []);
      for (const a of assessments) {
        const qText = (a.questions || []).map(q => `${q.prompt || ''} ${q.explanation || ''}`).join(' ');
        push({
          id: `asg_${a.id}`,
          classId: a.gradebook?.course_id || a.class_id || null,
          type: 'assessment',
          category: 'Assessments',
          title: a.title || 'Untitled Assessment',
          body: `${a.description || ''} ${qText}`,
          route: `#/assessments/edit?id=${a.id}`
        });
      }

      // 7. Tasks (Multimodal Assignments)
      const tasks = await storage.table('tasks').toArray().catch(() => []);
      for (const t of tasks) {
        push({
          id: `task_${t.id}`,
          classId: t.gradebook?.course_id || t.class_id || null,
          type: 'task',
          category: 'Assignments',
          title: t.title || 'Untitled Assignment',
          body: t.description || '',
          route: `#/assignments/create?id=${t.id}`
        });
      }

      // 8. Rubrics
      const rubrics = await storage.table('gradebook_rubrics').toArray().catch(() => []);
      for (const r of rubrics) {
        const critText = (r.criteria || []).map(cr => `${cr.title || ''} ${(cr.levels || []).map(l => l.description || '').join(' ')}`).join(' ');
        push({
          id: `rub_${r.id}`,
          classId: r.course_id || null,
          type: 'rubric',
          category: 'Rubrics',
          title: r.title || 'Untitled Rubric',
          body: critText,
          route: `#/gradebook?courseId=${r.course_id}&view=rubrics`
        });
      }

      // 9. Students
      const students = await storage.table('gradebook_students').toArray().catch(() => []);
      for (const s of students) {
        push({
          id: `std_${s.id}`,
          classId: s.course_id || null,
          type: 'student',
          category: 'Students',
          title: s.full_name || 'Student',
          body: `ID: ${s.student_id || ''} Email: ${s.email || ''}`,
          route: `#/classes?courseId=${s.course_id}`
        });
      }
    } catch (err) {
      console.warn('[SearchEngine] Error collecting documents:', err);
    }

    return docs;
  }

  static _handleStorageMutation(tableName, action, key, obj) {
    if (!this._initialized) return;

    if (action === 'delete') {
      const idPrefixes = {
        gradebook_courses: 'course_',
        course_units: 'unit_',
        course_items: 'item_',
        flashcards: 'fc_',
        timelines: 'tl_',
        video_assessments: 'vid_',
        assignments: 'asg_',
        tasks: 'task_',
        gradebook_rubrics: 'rub_',
        gradebook_students: 'std_'
      };
      const prefix = idPrefixes[tableName];
      if (prefix && key) {
        const docId = `${prefix}${key}`;
        if (this._worker) {
          this._worker.postMessage({ type: 'DOC_REMOVE', payload: { id: docId } });
        } else if (this._fallbackIndex) {
          this._fallbackIndex.delete(docId);
        }
      }
      return;
    }

    // For create/update, transform record into document and send to worker
    if (obj) {
      let doc = null;
      if (tableName === 'flashcards') {
        const cardsText = (obj.cards || []).map(c => `${c.front?.text || c.front || ''} ${c.back?.text || c.back || ''}`).join(' ');
        doc = { id: `fc_${obj.id}`, classId: obj.class_id, type: 'flashcards', category: 'Flashcards', title: obj.title, body: `${obj.description || ''} ${cardsText}`, route: `#/flashcards/study?id=${obj.id}` };
      } else if (tableName === 'assignments') {
        doc = { id: `asg_${obj.id}`, classId: obj.gradebook?.course_id || obj.class_id, type: 'assessment', category: 'Assessments', title: obj.title, body: obj.description || '', route: `#/assessments/edit?id=${obj.id}` };
      } else if (tableName === 'tasks') {
        doc = { id: `task_${obj.id}`, classId: obj.gradebook?.course_id || obj.class_id, type: 'task', category: 'Assignments', title: obj.title, body: obj.description || '', route: `#/assignments/create?id=${obj.id}` };
      } else if (tableName === 'gradebook_courses') {
        doc = { id: `course_${obj.id}`, classId: obj.id, type: 'course', category: 'Classes', title: obj.name, body: `${obj.section || ''} ${obj.academic_year || ''}`, route: `#/classes?courseId=${obj.id}` };
      }

      if (doc) {
        this._scanForWikilinks(doc.id, doc.body || '');
        if (this._worker) {
          this._worker.postMessage({ type: 'DOC_UPSERT', payload: doc });
        } else if (this._fallbackIndex) {
          this._fallbackIndex.set(doc.id, doc);
        }
      }
    }
  }

  static async search(queryStr, { limit = 20, classId = null } = {}) {
    await this.init();

    const q = String(queryStr || '').trim();
    if (!q) return [];

    let results = [];

    if (this._worker) {
      const correlationId = ++this._queryCounter;
      results = await new Promise((resolve) => {
        this._pendingQueries.set(correlationId, resolve);
        this._worker.postMessage({
          type: 'SEARCH',
          payload: { query: q, limit: limit * 2 },
          correlationId
        });
      });
    } else if (this._fallbackIndex) {
      // In-memory fallback
      const qLower = q.toLowerCase();
      const matched = [];
      for (const doc of this._fallbackIndex.values()) {
        const titleMatch = (doc.title || '').toLowerCase().includes(qLower);
        const bodyMatch = (doc.body || '').toLowerCase().includes(qLower);
        if (titleMatch || bodyMatch) {
          matched.push({
            id: doc.id,
            title: doc.title,
            category: doc.category,
            route: doc.route,
            classId: doc.classId || null,
            snippet: (doc.body || '').slice(0, 100),
            score: titleMatch ? 2.0 : 1.0
          });
        }
      }
      results = matched.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    // Filter by classId if active filter is applied
    if (classId) {
      results = results.filter(r => !r.classId || r.classId === classId);
    }

    return results.slice(0, limit);
  }

  static _scanForWikilinks(sourceDocId, text) {
    const matches = String(text || '').match(/\[\[([^\]]+)\]\]/g);
    if (!matches) return;

    for (const m of matches) {
      const target = m.slice(2, -2).trim().toLowerCase();
      if (!this._backlinks.has(target)) {
        this._backlinks.set(target, new Set());
      }
      this._backlinks.get(target).add(sourceDocId);
    }
  }

  static findBacklinks(targetKey) {
    const norm = String(targetKey || '').trim().toLowerCase();
    const set = this._backlinks.get(norm);
    return set ? Array.from(set) : [];
  }
}

export default SearchEngine;
