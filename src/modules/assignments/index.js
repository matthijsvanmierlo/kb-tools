import { storage } from '../../core/storage.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { ProjectLibraryView } from '../../components/project-library.js';
import { ClassManager } from '../../components/class-manager.js';
import { ensureSampleAssignment } from './seed.js';
import { cloneQuestion } from './question-types.js';
import { totalPoints } from './grading.js';
import { CSVImportDialog } from '../../components/csv-import-dialog.js';
import { ASSIGNMENT_CSV_TEMPLATE } from '../../core/csv-templates.js';
import { AssignmentQuestionRowSchema } from '../../core/validator.js';
import { ContentImporter } from '../../core/content-importer.js';
import { normalizeSharedEnvelope } from '../../core/shared-payload.js';

/**
 * Assignments Module Controller (KB-ASSIGN-000)
 * Routes: #/assignments (library), #/assignments/edit, #/assignments/take, #/assignments/submissions
 */
export async function renderAssignmentsView(params, router, container) {
  await ensureSampleAssignment();
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
  const now = new Date().toISOString();
  return {
    id: generateUUID(),
    version: 1,
    title: 'Untitled assignment',
    description: '',
    instructions: '',
    class_id: null,
    gradebook: { course_id: null, category_id: null, column_id: null, gradebook_assignment_id: null },
    settings: {
      feedback_mode: 'after_submit',
      show_correct_answers: false,
      shuffle_questions: false,
      shuffle_options: true,
      require_access_code: true,
      due_date: '',
      release_grade_immediately: true
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
    onImport: () => {
      CSVImportDialog.open({
        title: 'Import Assignment',
        subtitle: 'Upload a .kbshare assignment file, CSV/JSON file, or paste rows from Google Sheets or Excel.',
        templateFilename: 'assignment_template.csv',
        templateContent: ASSIGNMENT_CSV_TEMPLATE,
        schema: AssignmentQuestionRowSchema,
        acceptJson: true,
        acceptKbShare: true,
        onImport: async (resultData, rawText, { filename, isJson, isKbShare }) => {
          const activeClass = ClassManager.getActiveFilter() || null;
          if (isKbShare) {
            const res = await ContentImporter.importRecordToLibrary('assignment', resultData, {
              classId: activeClass,
              filename
            });
            toast.success(`Imported assignment "${res.title}" with ${res.count} questions from .kbshare!`);
          } else if (isJson) {
            const parsed = normalizeSharedEnvelope({ type: 'assignment', payload: resultData }).payload;
            const now = new Date().toISOString();
            const newAsg = {
              ...createBlankAssignment(),
              ...parsed,
              id: generateUUID(),
              title: parsed.title || (filename || 'Imported Assignment').replace(/\.[^/.]+$/, ''),
              class_id: activeClass || parsed.class_id || null,
              created_at: now,
              updated_at: now
            };
            await storage.table('assignments').put(newAsg);
            toast.success(`Imported assignment "${newAsg.title}" with ${newAsg.questions?.length || 0} questions from JSON!`);
          } else {
            let title = (filename || 'Imported Assignment').replace(/\.[^/.]+$/, '');
            if (title === 'pasted_data') title = 'Pasted Assignment';
            else if (title === 'assignment_template' || title === 'template') title = 'Assignment';
            else {
              title = title.replace(/[_\-]+/g, ' ');
              title = title.charAt(0).toUpperCase() + title.slice(1);
            }
            const now = new Date().toISOString();
            const newAsg = {
              ...createBlankAssignment(),
              title,
              class_id: activeClass,
              questions: Array.isArray(resultData) ? resultData : [],
              created_at: now,
              updated_at: now
            };
            await storage.table('assignments').put(newAsg);
            toast.success(`Imported assignment "${title}" with ${newAsg.questions.length} questions!`);
          }
          library.searchQuery = '';
          library.selectedClassId = activeClass;
          library.sortBy = 'updated';
          await library.render(container);
        }
      });
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
