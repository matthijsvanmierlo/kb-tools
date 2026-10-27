import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { getStudentCourse, mergeCourseFeed } from './course-store.js';
import { exportStudentSession } from './session-portability.js';
import { getStudentRelayUrl, PublicFeedTransport } from '../../core/transport.js';
import { deriveCourseFeedId } from '../../core/course-feed.js';
import { AdaptiveEngine } from '../../core/adaptive-engine.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

export async function renderStudentCourseDetailView(params, router, container) {
  const courseId = params?.id || params?.courseId;
  if (!courseId) {
    container.innerHTML = `
      <div class="p-8 text-center text-slate-500">
        <p>No course ID provided.</p>
        <sl-button size="small" class="mt-4" href="#/student/courses">Back to Courses</sl-button>
      </div>
    `;
    return;
  }

  const ctx = await getStudentCourse(courseId);
  if (!ctx || !ctx.course) {
    container.innerHTML = `
      <div class="p-8 text-center text-slate-500">
        <p>Course not found in your enrolled courses.</p>
        <sl-button size="small" class="mt-4" href="#/student/courses">Back to Courses</sl-button>
      </div>
    `;
    return;
  }

  const { course, units = [], items = [] } = ctx;
  const ledger = await storage.table('student_ledger').toArray().catch(() => []);

  // Map submissions/grades by item source_id or id
  const ledgerMap = new Map();
  for (const entry of ledger) {
    const key = entry.assignment_id || entry.item_id || entry.source_id;
    if (key) ledgerMap.set(key, entry);
  }

  const relayUrl = getStudentRelayUrl(course);
  const color = Sanitizer.safeColor(course.color, '#2563eb');
  const now = new Date().toISOString().slice(0, 10);

  container.innerHTML = `
    <div class="min-h-[calc(100vh-4rem)] bg-slate-50 pb-16">
      <!-- Course Banner -->
      <header class="bg-white border-b border-slate-200">
        <div class="max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div class="flex items-center gap-3.5 min-w-0">
            <div class="w-3.5 h-12 rounded-lg flex-shrink-0 shadow-xs" style="background-color: ${color};"></div>
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h1 class="text-xl sm:text-2xl font-bold text-slate-900 truncate">${esc(course.name)}</h1>
                ${course.section ? `<span class="px-2 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-700">${esc(course.section)}</span>` : ''}
              </div>
              <p class="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
                <span>Access Code: <strong class="font-mono text-slate-700">${esc(course.access_code || '—')}</strong></span>
                <span>•</span>
                <span>${items.length} lesson${items.length === 1 ? '' : 's'}</span>
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2 flex-wrap">
            ${relayUrl ? `
              <sl-button size="small" variant="default" id="btn-refresh-feed">
                <sl-icon slot="prefix" name="arrow-clockwise"></sl-icon> Check for updates
              </sl-button>
            ` : ''}
            <sl-button size="small" variant="default" id="btn-export-session">
              <sl-icon slot="prefix" name="download"></sl-icon> Save Session (.kbsession)
            </sl-button>
            <sl-button size="small" variant="default" href="#/student/courses">
              <sl-icon slot="prefix" name="arrow-left"></sl-icon> All Courses
            </sl-button>
            <sl-button size="small" variant="default" href="#/student/gradebook">
              <sl-icon slot="prefix" name="journal-check"></sl-icon> My Grades
            </sl-button>
          </div>
        </div>
      </header>

      <!-- Units & Items Content -->
      <main class="max-w-5xl mx-auto px-4 sm:px-6 pt-6 space-y-6">
        ${units.length === 0 && items.length === 0 ? `
          <div class="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center text-slate-400">
            <sl-icon name="collection" class="text-5xl text-slate-300 mb-3"></sl-icon>
            <h3 class="text-base font-semibold text-slate-700">No lessons published yet</h3>
            <p class="text-xs text-slate-500 max-w-sm mx-auto mt-1">Your teacher has not published units or items for this course yet.</p>
          </div>
        ` : (units.length > 0 ? units : [{ id: null, title: 'Course Lessons' }]).map((u, uIdx) => {
          const unitItems = u.id ? items.filter(it => it.unit_id === u.id) : items;
          if (unitItems.length === 0 && !u.id) return '';
          const uColor = u.color ? Sanitizer.safeColor(u.color) : null;

          return `
            <section class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden ${uColor ? 'border-l-4' : ''}" style="${uColor ? `border-left-color: ${uColor};` : ''}">
              <div class="bg-slate-50/80 border-b border-slate-200 px-5 py-3 flex items-center justify-between">
                <div class="flex items-center gap-2.5 min-w-0">
                  <span class="w-6 h-6 rounded-full font-semibold text-xs flex items-center justify-center flex-shrink-0" style="${uColor ? `background-color: ${uColor}20; color: ${uColor};` : 'background-color: #e2e8f0; color: #334155;'}">
                    ${uIdx + 1}
                  </span>
                  <div class="min-w-0">
                    <h3 class="text-sm font-bold text-slate-900 truncate">${esc(u.title || 'Course Outline')}</h3>
                    ${u.description ? `<p class="text-xs text-slate-500 truncate">${esc(u.description)}</p>` : ''}
                  </div>
                </div>
                <span class="text-xs text-slate-500 flex-shrink-0">${unitItems.length} item${unitItems.length === 1 ? '' : 's'}</span>
              </div>

              <div class="divide-y divide-slate-100 p-2">
                ${unitItems.length === 0 ? `
                  <div class="py-4 text-center text-xs text-slate-400">No items in this unit.</div>
                ` : unitItems.map(it => {
                  const kind = it.kind || it.type || 'assignment';
                  const sourceId = it.source_id || it.id;
                  const submission = ledgerMap.get(sourceId) || ledgerMap.get(it.id);
                  const access = AdaptiveEngine.evaluateItemAccess(it, ledger, items);

                  let statusPill = '<span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-600">Not started</span>';
                  if (!access.unlocked) {
                    statusPill = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1"><sl-icon name="lock-fill"></sl-icon> Requires: ${esc(access.missingItemTitle)} (≥${access.requiredScore}%)</span>`;
                  } else if (submission) {
                    if (submission.percent !== undefined) {
                      statusPill = `<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800">Completed (${Math.round(submission.percent)}%)</span>`;
                    } else {
                      statusPill = '<span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-100 text-blue-800">Submitted</span>';
                    }
                  }

                  let dueText = '';
                  if (it.due_date) {
                    const isOverdue = it.due_date < now && !submission;
                    const isToday = it.due_date === now;
                    dueText = `
                      <span class="${isOverdue ? 'text-rose-600 font-bold' : isToday ? 'text-amber-700 font-bold' : 'text-slate-500'} flex items-center gap-1">
                        <sl-icon name="calendar-event"></sl-icon> ${isOverdue ? 'Overdue: ' : isToday ? 'Due Today: ' : 'Due: '} ${esc(it.due_date)}
                      </span>
                    `;
                  }

                  const icons = {
                    assignment: 'file-earmark-check text-blue-600',
                    task: 'journal-text text-indigo-600',
                    flashcards: 'collection text-purple-600',
                    timeline: 'clock-history text-emerald-600',
                    video: 'play-circle text-rose-600'
                  };
                  const iconClass = icons[kind] || 'file-earmark text-slate-500';

                  // Determine launch URL
                  let launchUrl = `#/assessments/take?itemId=${encodeURIComponent(it.id)}`;
                  if (kind === 'task') launchUrl = `#/assignments/work?itemId=${encodeURIComponent(it.id)}`;
                  else if (kind === 'flashcards') launchUrl = `#/flashcards/study?id=${encodeURIComponent(sourceId)}`;
                  else if (kind === 'timeline') launchUrl = `#/timeline/view?id=${encodeURIComponent(sourceId)}`;
                  else if (kind === 'video') launchUrl = `#/video/kiosk?id=${encodeURIComponent(sourceId)}`;

                  const displayKind = kind === 'assignment' ? 'Assessment' : (kind === 'task' ? 'Assignment' : kind);

                  return `
                    <div class="flex flex-col sm:flex-row sm:items-center justify-between p-3.5 rounded-xl hover:bg-slate-50/80 transition-colors gap-3">
                      <div class="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                        <sl-icon name="${iconClass.split(' ')[0]}" class="text-xl flex-shrink-0 mt-0.5 sm:mt-0 ${iconClass.split(' ')[1] || ''}"></sl-icon>
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2 flex-wrap">
                            <h4 class="text-sm font-semibold text-slate-900">${esc(it.title)}</h4>
                            ${statusPill}
                          </div>
                          <div class="flex items-center gap-3 text-xs text-slate-500 mt-1 flex-wrap">
                            <span class="capitalize text-slate-600 font-medium">${esc(displayKind)}</span>
                            ${dueText ? `<span>•</span>${dueText}` : ''}
                            ${it.points ? `<span>•</span><span>${it.points} pts</span>` : ''}
                          </div>
                        </div>
                      </div>

                      <div class="flex items-center gap-2 self-end sm:self-auto flex-shrink-0">
                        ${!access.unlocked ? `
                          <sl-button size="small" variant="default" disabled>
                            <sl-icon slot="prefix" name="lock"></sl-icon> Locked
                          </sl-button>
                        ` : `
                          <sl-button size="small" variant="${submission ? 'default' : 'primary'}" href="${launchUrl}">
                            ${submission ? 'Review / Retake' : 'Open Lesson'}
                          </sl-button>
                        `}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </section>
          `;
        }).join('')}
      </main>
    </div>
  `;

  container.querySelector('#btn-export-session')?.addEventListener('click', () => {
    exportStudentSession();
  });

  let disposed = false;
  const checkForUpdates = async (interactive = false) => {
    if (!relayUrl || !course.access_code || disposed) return;
    try {
      const feedId = await deriveCourseFeedId(course.access_code);
      const transport = new PublicFeedTransport({ baseUrl: relayUrl });
      const res = await transport.fetchCourseFeed(feedId, course.etag || course.revision);
      if (disposed) return;
      if (res && res.ciphertext) {
        await mergeCourseFeed(res.ciphertext, {
          accessCode: course.access_code,
          etag: res.etag,
          relayUrl
        });
        toast.success('Course updated with latest changes from your teacher!');
        renderStudentCourseDetailView(params, router, container);
      } else if (interactive) {
        toast.info('Course is up to date.');
      }
    } catch (err) {
      if (interactive) {
        toast.warning('Could not check for updates: ' + (err.message || 'network error'));
      }
    }
  };

  const refreshBtn = container.querySelector('#btn-refresh-feed');
  refreshBtn?.addEventListener('click', async () => {
    refreshBtn.loading = true;
    await checkForUpdates(true);
    refreshBtn.loading = false;
  });

  let onVisibilityChange = null;
  if (relayUrl && course.access_code) {
    onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkForUpdates(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Background check on load
    checkForUpdates(false);
  }

  return () => {
    disposed = true;
    if (onVisibilityChange) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}
