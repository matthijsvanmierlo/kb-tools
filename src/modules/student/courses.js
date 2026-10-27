import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { PromptDialog } from '../../utils/dialogs.js';
import { exportStudentSession, importStudentSession } from './session-portability.js';
import { getTransport, PublicFeedTransport, getStudentRelayUrl } from '../../core/transport.js';
import { deriveCourseFeedId } from '../../core/course-feed.js';
import { mergeCourseFeed, getStudentCourses, reconcileStudentCoursesWithProfile, joinCourseByCode } from './course-store.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

export async function renderStudentCoursesView(params, router, container) {
  let doEnrollWithCode = null;
  const hashSearch = typeof window !== 'undefined' ? new URLSearchParams(window.location.hash.split('?')[1] || '') : new URLSearchParams();

  await reconcileStudentCoursesWithProfile();

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
            <sl-button size="small" variant="default" id="btn-scan-course-qr">
              <sl-icon slot="prefix" name="camera"></sl-icon> Scan Course QR
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
              <p class="text-xs text-slate-500 max-w-sm mx-auto mt-1">Scan a course QR code or enter an access code from your teacher to join your class.</p>
              <div class="flex items-center justify-center gap-2 mt-4 flex-wrap">
                <sl-button size="small" variant="primary" id="btn-scan-course-first">
                  <sl-icon slot="prefix" name="camera"></sl-icon> Scan Course QR
                </sl-button>
                <sl-button size="small" variant="default" id="btn-enroll-first">
                  <sl-icon slot="prefix" name="plus-lg"></sl-icon> Enter Access Code
                </sl-button>
              </div>
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
                      <h3 class="text-base font-bold text-slate-900 truncate">${esc(c.name || c.course_name || 'Enrolled Course')}</h3>
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

    doEnrollWithCode = async (code, relayUrlOverride = null, meta = {}) => {
      const normalizedCode = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (normalizedCode.length < 4 && !meta.embeddedPayload && !params?.d) {
        toast.warning('Please enter a valid access code.');
        return;
      }

      const relayUrl = relayUrlOverride || params?.relay || getStudentRelayUrl();

      // 0. Embedded encrypted payload from URL (#/student/courses?code=...&d=...)
      const embeddedD = meta.embeddedPayload || params?.d || hashSearch.get('d');
      if (embeddedD) {
        try {
          const { decryptCourseFeed } = await import('../../core/course-feed.js');
          const decrypted = await decryptCourseFeed(embeddedD, code);
          const merged = await mergeCourseFeed(decrypted, { accessCode: code, relayUrl });
          if (merged?.course?.id) {
            toast.success(`Joined "${merged.course.name || 'Course'}"!`);
            await render();
            if (router?.navigate) {
              router.navigate(`#/student/course?id=${encodeURIComponent(merged.course.id)}`);
            }
            return;
          }
        } catch (err) {
          console.warn('Failed to decrypt embedded feed parameter:', err);
        }
      }

      // 1. Try fetching from configured relay
      if (relayUrl) {
        try {
          const feedId = await deriveCourseFeedId(normalizedCode);
          const transport = new PublicFeedTransport({ baseUrl: relayUrl });
          const feedRes = await transport.fetchCourseFeed(feedId);
          if (feedRes && feedRes.ciphertext) {
            const merged = await mergeCourseFeed(feedRes.ciphertext, {
              accessCode: normalizedCode,
              etag: feedRes.etag,
              relayUrl
            });
            const { StudentProfile } = await import('../../core/student-profile.js');
            if (merged?.course?.id) {
              await StudentProfile.saveClassAccessCode(merged.course.id, normalizedCode);
            }
            toast.success('Successfully joined course and loaded course feed!');
            await render();
            const prof = StudentProfile.resolveForPayload({ course_id: merged?.course?.id });
            if (!prof.hasSavedIdentity && merged?.course) {
              openClaimSeatDialog(merged.course, () => {
                router.navigate(`#/student/course?id=${encodeURIComponent(merged.course.id)}`);
              });
            } else if (merged?.course?.id) {
              router.navigate(`#/student/course?id=${encodeURIComponent(merged.course.id)}`);
            }
            return;
          }
        } catch (err) {
          console.warn('Relay course lookup error:', err);
        }
      }

      // 2. Local fallback: search existing teacher courses by course access code
      const allCourses = await storage.table('gradebook_courses').toArray().catch(() => []);
      let localCourse = allCourses.find(c => {
        const cCode = String(c.access_code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        return cCode === normalizedCode || c.id === code;
      });

      // 3. Fallback: search by student's personalized access code in gradebook_students
      if (!localCourse) {
        const allStudents = await storage.table('gradebook_students').toArray().catch(() => []);
        const studentRec = allStudents.find(s => {
          const sCode = String(s.access_code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
          return sCode === normalizedCode;
        });

        if (studentRec && studentRec.course_id) {
          localCourse = await storage.table('gradebook_courses').get(studentRec.course_id).catch(() => null);
          if (localCourse) {
            // Auto-populate student identity in profile
            const { StudentProfile } = await import('../../core/student-profile.js');
            await StudentProfile.saveIdentity({
              studentId: studentRec.student_id,
              fullName: studentRec.full_name,
              email: studentRec.email || ''
            });
            await StudentProfile.saveClassAccessCode(localCourse.id, code);
          }
        }
      }

      if (localCourse) {
        const { buildCourseFeed } = await import('../../core/course-feed.js');
        const feed = await buildCourseFeed(localCourse.id, { relayUrl });
        const merged = await mergeCourseFeed(feed.raw_payload, { accessCode: code, relayUrl });
        const { StudentProfile } = await import('../../core/student-profile.js');
        await StudentProfile.saveClassAccessCode(localCourse.id, code);
        toast.success(`Joined "${localCourse.name}"!`);
        await render();
        if (router?.navigate) {
          router.navigate(`#/student/course?id=${encodeURIComponent(localCourse.id)}`);
        }
      } else {
        try {
          const res = await joinCourseByCode(code, {
            courseId: meta.courseId || params?.cid || hashSearch.get('cid'),
            courseName: meta.courseName || params?.cname || hashSearch.get('cname'),
            section: meta.section || params?.csec || hashSearch.get('csec'),
            color: meta.color || params?.ccolor || hashSearch.get('ccolor'),
            relayUrl
          });
          if (res) {
            toast.success(`Joined "${res.name || res.course?.name || 'Class'}"!`);
            await render();
            const targetId = res.course?.id || res.id;
            if (router?.navigate && targetId) {
              router.navigate(`#/student/course?id=${encodeURIComponent(targetId)}`);
            }
            return;
          }
        } catch (_) {}
        toast.warning(`Could not find a course matching code "${normalizedCode}". Make sure you typed it correctly or ask your teacher for the link.`);
      }
    };

    const enrollCourse = async () => {
      const code = await PromptDialog.show({
        title: 'Join Class',
        message: 'Enter the 6-character access code provided by your teacher (e.g. K7M2QX)',
        placeholder: 'Access code'
      });
      if (code) await doEnrollWithCode(code);
    };

    const scanCourseQr = async () => {
      const { openQrScanner } = await import('../../components/qr-handoff.js');
      const { UniversalImportDialog } = await import('../../components/universal-import-dialog.js');
      openQrScanner({
        label: 'Scan Course QR Code or Card',
        readyText: 'Point camera at the course enrollment QR code on screen or paper...',
        once: true,
        onResult: async (decodedText) => {
          let code = String(decodedText || '').trim();
          let scannedRelay = null;
          if (code.includes('code=')) {
            const matchCode = code.match(/code=([^&]+)/);
            if (matchCode) code = decodeURIComponent(matchCode[1]);
            const matchRelay = decodedText.match(/relay=([^&]+)/);
            if (matchRelay) scannedRelay = decodeURIComponent(matchRelay[1]);
          }
          if (code.length <= 12 && /^[A-Z0-9_-]+$/i.test(code)) {
            await doEnrollWithCode(code, scannedRelay);
          } else {
            await UniversalImportDialog.handleScannedPayload(decodedText, {
              role: 'student'
            });
            render();
          }
        }
      });
    };

    container.querySelector('#btn-scan-course-qr')?.addEventListener('click', scanCourseQr);
    container.querySelector('#btn-scan-course-first')?.addEventListener('click', scanCourseQr);
    container.querySelector('#btn-enroll-course')?.addEventListener('click', enrollCourse);
    container.querySelector('#btn-enroll-first')?.addEventListener('click', enrollCourse);
  };

  await render();

  const joinCode = params?.code || params?.join || hashSearch.get('code') || hashSearch.get('join');
  const relayUrl = params?.relay || hashSearch.get('relay');

  if ((joinCode || hashSearch.has('d')) && doEnrollWithCode) {
    await doEnrollWithCode(joinCode, relayUrl, {
      courseId: params?.cid || hashSearch.get('cid'),
      courseName: params?.cname || hashSearch.get('cname'),
      section: params?.csec || hashSearch.get('csec'),
      color: params?.ccolor || hashSearch.get('ccolor'),
      embeddedPayload: params?.d || hashSearch.get('d')
    });
  }
}

function openClaimSeatDialog(course, onDone) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = `Claim Your Seat in ${course.name || 'Course'}`;
  dialog.innerHTML = `
    <div class="space-y-4 text-sm">
      <p class="text-xs text-slate-600 leading-relaxed">
        To submit assignments and receive private feedback in <strong>${Sanitizer.escapeHTML(course.name || 'this class')}</strong>, enter your student information or personal Student Access Code.
      </p>
      <sl-input id="claim-student-code" label="Personal Student Access Code (optional)" placeholder="e.g. K7M2-QX9P">
        <sl-icon slot="prefix" name="key"></sl-icon>
      </sl-input>
      <sl-input id="claim-student-name" label="Your Full Name" placeholder="e.g. Alex Rivera" required></sl-input>
      <sl-input id="claim-student-id" label="Student ID / SIS ID" placeholder="e.g. S1042" required></sl-input>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button id="btn-claim-skip">Skip for Now</sl-button>
      <sl-button variant="primary" id="btn-claim-save">Save &amp; Continue</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-claim-skip')?.addEventListener('click', () => {
    dialog.hide();
    if (onDone) onDone();
  });

  dialog.querySelector('#btn-claim-save')?.addEventListener('click', async () => {
    const code = dialog.querySelector('#claim-student-code')?.value?.trim();
    const name = dialog.querySelector('#claim-student-name')?.value?.trim();
    const sid = dialog.querySelector('#claim-student-id')?.value?.trim();

    if (!name || !sid) {
      toast.warning('Please enter your name and Student ID.');
      return;
    }

    const { StudentProfile } = await import('../../core/student-profile.js');
    await StudentProfile.saveIdentity({
      studentId: sid,
      fullName: name,
      accessCode: code || undefined,
      courseId: course.id,
      courseName: course.name,
      section: course.section
    });

    toast.success('Student seat claimed and saved to keychain!');
    dialog.hide();
    if (onDone) onDone();
  });

  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target !== dialog) return;
    dialog.remove();
  });
}
