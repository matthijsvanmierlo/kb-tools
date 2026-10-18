import { storage } from '../../core/storage.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { ProjectLibraryView } from '../../components/project-library.js';
import { ClassManager } from '../../components/class-manager.js';
import { ensureSampleAssignment } from './seed.js';
import { cloneQuestion } from './question-types.js';
import { totalPoints } from './grading.js';

/**
 * Assignments Module Controller (KB-ASSIGN-000)
 * Routes: #/assignments (library), #/assignments/edit, #/assignments/take, #/assignments/submissions
 */
export async function renderAssignmentsView(params, router, container) {
  const hash = window.location.hash || '#/assignments';

  if (hash.startsWith('#/assignments/take')) {
    const { renderTakeView } = await import('./take.js');
    return renderTakeView(params, router, container);
  }

  if (hash.startsWith('#/assignments/edit')) {
    let assignment = params.id ? await storage.table('assignments').get(params.id) : null;
    if (params.id && !assignment) {
      toast.warning('Assignment not found.');
      router.navigate('#/assignments');
      return;
    }
    if (!assignment) {
      assignment = createBlankAssignment();
      await storage.table('assignments').put(assignment);
      // Keep the URL pointing at the saved record so reloads don't create duplicates
      history.replaceState(null, '', `#/assignments/edit?id=${assignment.id}`);
    }
    const { renderEditor } = await import('./editor.js');
    return renderEditor(assignment, router, container);
  }

  if (hash.startsWith('#/assignments/submissions')) {
    const assignment = params.id ? await storage.table('assignments').get(params.id) : null;
    if (!assignment) {
      toast.warning('Assignment not found.');
      router.navigate('#/assignments');
      return;
    }
    const { renderSubmissions } = await import('./submissions.js');
    return renderSubmissions(assignment, router, container);
  }

  return renderLibrary(container);
}

export function createBlankAssignment() {
  const classId = ClassManager.getActiveFilter();
  const now = new Date().toISOString();
  return {
    id: generateUUID(),
    version: 1,
    title: 'Untitled assignment',
    description: '',
    instructions: '',
    class_id: classId && classId !== 'unassigned' ? classId : null,
    gradebook: { course_id: classId && classId !== 'unassigned' ? classId : null, category_id: null, column_id: null },
    settings: {
      feedback_mode: 'after_submit',
      show_correct_answers: false,
      shuffle_questions: false,
      shuffle_options: true,
      require_access_code: true,
      due_date: ''
    },
    questions: [],
    publish: null,
    created_at: now,
    updated_at: now
  };
}

async function renderLibrary(container) {
  const submissions = await storage.table('assignment_submissions').toArray().catch(() => []);
  const counts = submissions.reduce((m, s) => m.set(s.assignment_id, (m.get(s.assignment_id) || 0) + (s.is_latest === false ? 0 : 1)), new Map());

  const library = new ProjectLibraryView({
    moduleType: 'assignments',
    title: 'Assignments',
    itemTypeName: 'Assignment',
    tableName: 'assignments',
    createRoute: '#/assignments/edit',
    accentColor: '#d97706',
    iconName: 'ui-checks',
    getOpenUrl: (item) => `#/assignments/edit?id=${item.id}`,
    getEditUrl: (item) => `#/assignments/edit?id=${item.id}`,
    getMetadataSummary: (item) => {
      const n = item.questions?.length || 0;
      const sub = counts.get(item.id) || 0;
      return `${n} question${n === 1 ? '' : 's'} • ${totalPoints(item)} pts${sub ? ` • ${sub} submitted` : ''}`;
    },
    // The generic share would send the full record (answer key included); publish safely instead
    onShare: async (item) => {
      const { openPublishDialog } = await import('./publish.js');
      openPublishDialog(item);
    },
    onDuplicate: async (item) => {
      const now = new Date().toISOString();
      const copy = {
        ...JSON.parse(JSON.stringify(item)),
        id: generateUUID(),
        title: `${item.title || 'Assignment'} (Copy)`,
        questions: (item.questions || []).map(cloneQuestion),
        gradebook: { ...(item.gradebook || {}), column_id: null },
        publish: null,
        created_at: now,
        updated_at: now
      };
      await storage.table('assignments').put(copy);
      toast.success('Assignment duplicated!');
      library.render(container);
    }
  });

  await library.render(container);
}

export default renderAssignmentsView;
