import { storage } from '../../core/storage.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { ProjectLibraryView } from '../../components/project-library.js';
import { openTaskPublishDialog } from './publish.js';

/**
 * Tasks Module (Branded as "Assignments" in the UI)
 * Internal type: 'task' / 'kb-task'
 */

export function createBlankTask() {
  const now = new Date().toISOString();
  return {
    id: generateUUID(),
    version: 1,
    title: 'Untitled assignment',
    description: '',
    class_id: null,
    gradebook: { course_id: null, category_id: null, column_id: null, gradebook_assignment_id: null },
    grading: { scoring: 'points', max_points: 100, rubric_id: null, standard_ids: [] },
    submission_types: {
      text: { enabled: true },
      code: { enabled: false, languages: ['python', 'javascript'], default_language: 'python', filename_hint: 'solution.py' },
      code_files: { enabled: false, accept: ['.py', '.js', '.html', '.css', '.java', '.cpp', '.sql'], max_files: 5 },
      files: { enabled: false, accept: ['.pdf', '.png', '.jpg', '.jpeg', '.zip'], max_files: 3, max_mb: 25 },
      drawing: { enabled: false }
    },
    settings: {
      due_date: '',
      due_time: '',
      require_access_code: true,
      allow_resubmit: true,
      release_feedback_immediately: true
    },
    publish: null,
    created_at: now,
    updated_at: now
  };
}

export async function renderTaskLibrary(container) {
  const submissions = await storage.table('task_submissions').toArray().catch(() => []);
  const counts = submissions.reduce((m, s) => {
    if (s.is_latest !== false) {
      m.set(s.task_id, (m.get(s.task_id) || 0) + 1);
    }
    return m;
  }, new Map());

  const library = new ProjectLibraryView({
    moduleType: 'tasks',
    title: 'Assignments',
    itemTypeName: 'Assignment',
    tableName: 'tasks',
    createRoute: '#/assignments/create',
    accentColor: '#4f46e5',
    iconName: 'journal-text',
    getOpenUrl: (item) => `#/assignments/create?id=${item.id}`,
    getEditUrl: (item) => `#/assignments/create?id=${item.id}`,
    getMetadataSummary: (item) => {
      const types = [];
      if (item.submission_types?.text?.enabled) types.push('Text');
      if (item.submission_types?.code?.enabled) types.push('Code');
      if (item.submission_types?.code_files?.enabled) types.push('Code files');
      if (item.submission_types?.files?.enabled) types.push('Files');
      if (item.submission_types?.drawing?.enabled) types.push('Drawing');
      const typeStr = types.length ? types.join(', ') : 'No submission types';
      const sub = counts.get(item.id) || 0;
      const pts = item.grading?.scoring === 'proficiency' ? 'Proficiency' : `${item.grading?.max_points ?? 100} pts`;
      return `${typeStr} • ${pts}${sub ? ` • ${sub} submitted` : ''}`;
    },
    onShare: async (item) => {
      openTaskPublishDialog(item);
    },
    onDuplicate: async (item) => {
      const now = new Date().toISOString();
      const copy = {
        ...JSON.parse(JSON.stringify(item)),
        id: generateUUID(),
        title: `${item.title || 'Assignment'} (Copy)`,
        gradebook: { ...(item.gradebook || {}), column_id: null },
        publish: null,
        created_at: now,
        updated_at: now
      };
      await storage.table('tasks').put(copy);
      toast.success(`Duplicated "${copy.title}"`);
      await library.render(container);
    }
  });

  await library.render(container);
}

/**
 * Tasks router dispatch function.
 * Matches #/assignments, #/assignments/create, #/assignments/work, #/assignments/review
 */
export default async function tasksModule(routeOrParams, maybeParamsOrRouter = {}, maybeRouterOrContainer = null, maybeContainer = null) {
  let route = '';
  let params = {};
  let router = null;
  let container = null;

  if (typeof routeOrParams === 'string') {
    route = routeOrParams;
    params = maybeParamsOrRouter || {};
    router = maybeRouterOrContainer;
    container = maybeContainer;
  } else {
    params = routeOrParams || {};
    router = maybeParamsOrRouter;
    container = maybeRouterOrContainer;
    const rawHash = (typeof window !== 'undefined' ? window.location.hash : '') || '#/assignments';
    route = rawHash.split('?')[0].toLowerCase();
  }

  const mount = container || document.getElementById('main-content');
  if (!mount) return;

  if (route === '#/assignments/create' || route === '#/assignments/edit') {
    const { renderTaskEditor } = await import('./editor.js');
    const id = params.id;
    let task = null;
    if (id) {
      task = await storage.table('tasks').get(id);
    }
    if (!task) {
      task = createBlankTask();
      await storage.table('tasks').put(task);
      if (router && !id) {
        window.location.hash = `#/assignments/create?id=${task.id}`;
      }
    }
    await renderTaskEditor(task, router || { navigate: (h) => { window.location.hash = h; } }, mount);
    return;
  }

  if (route === '#/assignments/work' || route === '#/assignments/take') {
    const { renderTaskTake } = await import('./take.js');
    await renderTaskTake(params, router, mount);
    return;
  }

  if (route === '#/assignments/review' || route === '#/assignments/submissions') {
    const { renderTaskSubmissions } = await import('./submissions.js');
    await renderTaskSubmissions(params, router, mount);
    return;
  }

  // Default: Library view (#/assignments)
  await renderTaskLibrary(mount);
}
