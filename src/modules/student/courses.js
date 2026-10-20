import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { PromptDialog } from '../../utils/dialogs.js';
import { getStudentCourses } from './course-store.js';
import { exportStudentSession, importStudentSession } from './session-portability.js';
import { getTransport, PublicFeedTransport } from '../../core/transport.js';
import { mergeCourseFeed } from './course-store.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

export async function renderStudentCoursesView(params, router, container) {
  const render = async () => {
    const courses = await getStudentCourses();
    const items = await storage.table('student_items').toArray().catch(() => []);

    container.innerHTML = `
      <div class="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <!-- Header -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <h1 class="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <sl-icon name="collection" class="text-blue-600"></sl-icon> My Enrolled Courses
            </h1>
            <p class="text-xs text-slate-500 mt-1">Courses, assignments, and study materials synchronized to your device.</p>
          </div>

          <div class="flex items-center gap-2 flex-wrap">
            <sl-button size="small" variant="default" id="btn-export-session">
              <sl-icon slot="prefix" name="download"></sl-icon> Save Session (.kbsession)
            </sl-button>
            <sl-button size="small" variant="default" id="btn-import-session">
              <sl-icon slot="prefix" name="upload"></sl-icon> Resume Session
            </sl-button>
            <sl-button size="small" variant="primary" id="btn-enroll-course">
              <sl-icon slot="prefix" name="plus-lg"></sl-icon> Join Course
            </sl-button>
            <input type="file" id="input-session-file" accept=".kbsession,.json" class="hidden" />
          </div>
        </div>

        <!-- Course Cards -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          ${courses.length === 0 ? `
            <div class="col-span-full bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center text-slate-400">
              <sl-icon name="mortarboard" class="text-5xl text-slate-300 mb-3"></sl-icon>
              <h3 class="text-base font-semibold text-slate-700">No courses joined yet</h3>
              <p class="text-xs text-slate-500 max-w-sm mx-auto mt-1">Enter a 6-character access code from your teacher to join your class and access lessons offline.</p>
              <sl-button size="small" variant="primary" class="mt-4" id="btn-enroll-first">
                <sl-icon slot="prefix" name="plus-lg"></sl-icon> Join a Course
              </sl-button>
            </div>
          ` : courses.map(c => {
            const courseItems = items.filter(it => it.course_id === c.id);
            const color = Sanitizer.safeColor(c.color, '#2563eb');

            return `
              <div class="bg-white rounded-2xl border border-slate-200 shadow-xs hover:shadow-md transition-all p-5 flex flex-col justify-between gap-4">
                <div class="space-y-2">
                  <div class="flex items-center gap-3">
                    <div class="w-3.5 h-10 rounded-full flex-shrink-0" style="background-color: ${color};"></div>
                    <div class="min-w-0 flex-1">
                      <h3 class="text-base font-bold text-slate-900 truncate">${esc(c.name)}</h3>
                      <div class="text-xs text-slate-500 truncate">
                        ${c.section ? `<span>${esc(c.section)}</span> • ` : ''}
                        <span>${esc(c.academic_year || 'Current')}</span>
                      </div>
                    </div>
                  </div>

                  <div class="text-xs text-slate-600 flex items-center gap-2 pt-2 border-t border-slate-100">
                    <span class="font-medium">${courseItems.length} lesson${courseItems.length === 1 ? '' : 's'} / assignment${courseItems.length === 1 ? '' : 's'}</span>
                  </div>
                </div>

                <div class="flex items-center justify-between gap-2 pt-1">
                  <span class="text-[11px] font-mono text-slate-400">Code: ${esc(c.access_code || '—')}</span>
                  <sl-button size="small" variant="primary" href="#/student/course?id=${esc(c.id)}">
                    Open Course
                  </sl-button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    // Session Export & Import
    container.querySelector('#btn-export-session')?.addEventListener('click', () => {
      exportStudentSession();
    });

    const fileInput = container.querySelector('#input-session-file');
    container.querySelector('#btn-import-session')?.addEventListener('click', () => {
      fileInput?.click();
    });

    fileInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        await importStudentSession(file);
        render();
      }
      fileInput.value = '';
    });

    const enrollCourse = async () => {
      const code = await PromptDialog.show({
        title: 'Join Class',
        message: 'Enter the 6-character access code provided by your teacher (e.g. K7M2QX)',
        placeholder: 'Access code'
      });
      if (!code) return;

      const normalizedCode = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (normalizedCode.length < 4) {
        toast.warning('Please enter a valid access code.');
        return;
      }

      // Try fetching from configured relay or search local courses
      try {
        const config = await storage.getMetadata('sync_config');
        if (config?.baseUrl) {
          const transport = new PublicFeedTransport(config);
          const feedRes = await transport.fetchCourseFeed(normalizedCode);
          if (feedRes && feedRes.ciphertext) {
            await mergeCourseFeed(feedRes.ciphertext, { accessCode: normalizedCode });
            toast.success('Successfully joined course and loaded course feed!');
            render();
            return;
          }
        }
      } catch (err) {
        console.warn('Relay course lookup error:', err);
      }

      // Local fallback: search existing teacher courses in same browser (shared device / demo)
      const localCourse = await storage.table('gradebook_courses').where('access_code').equals(normalizedCode).first().catch(() => null);
      if (localCourse) {
        const [units, items] = await Promise.all([
          storage.table('course_units').where('course_id').equals(localCourse.id).toArray().catch(() => []),
          storage.table('course_items').where('course_id').equals(localCourse.id).toArray().catch(() => [])
        ]);
        await mergeCourseFeed({ course: localCourse, units, items }, { accessCode: normalizedCode });
        toast.success(`Joined "${localCourse.name}"!`);
        render();
      } else {
        toast.warning(`Could not find a course matching code "${normalizedCode}". Make sure you typed it correctly or ask your teacher for the link.`);
      }
    };

    container.querySelector('#btn-enroll-course')?.addEventListener('click', enrollCourse);
    container.querySelector('#btn-enroll-first')?.addEventListener('click', enrollCourse);
  };

  await render();
}
