/**
 * Teacher Guide (#/guide) (KB-GUIDE-001)
 *
 * Platform overview and recommended workflows: how to set up a class, which tool fits which
 * goal, and step-by-step create → deliver → collect → grade → report routines. Static content;
 * every "Open" button deep-links into the screen the step refers to.
 */

const SECTIONS = [
  { id: 'guide-loop', label: 'The weekly loop', icon: 'arrow-repeat' },
  { id: 'guide-setup', label: 'Set up a class', icon: 'mortarboard' },
  { id: 'guide-tools', label: 'Choose a tool', icon: 'signpost-split' },
  { id: 'guide-assignments', label: 'Auto-graded work', icon: 'ui-checks' },
  { id: 'guide-assigning', label: 'Delivery & Hand-in Matrix', icon: 'diagram-3' },
  { id: 'guide-video', label: 'Video lessons', icon: 'play-circle' },
  { id: 'guide-rubric', label: 'Hand-graded work', icon: 'grid-3x3' },
  { id: 'guide-sbg', label: 'Standards-based', icon: 'bullseye' },
  { id: 'guide-study', label: 'Study & review', icon: 'stack' },
  { id: 'guide-report', label: 'Report back', icon: 'send' },
  { id: 'guide-defaults', label: 'Recommended settings', icon: 'check2-square' },
  { id: 'guide-safety', label: 'Keep data safe', icon: 'shield-lock' },
  { id: 'guide-server', label: 'Connect to a school server', icon: 'cloud-arrow-up' },
  { id: 'guide-faq', label: 'Interactive FAQ', icon: 'patch-question' },
  { id: 'guide-help', label: 'Troubleshooting', icon: 'life-preserver' }
];

const LOOP = [
  { icon: 'mortarboard', title: 'Set up', text: 'Class, roster, policies and access codes. Once per class.', tone: 'emerald' },
  { icon: 'pencil-square', title: 'Create', text: 'Build an assignment, video lesson, deck or timeline.', tone: 'blue' },
  { icon: 'link-45deg', title: 'Deliver', text: 'Share a student link in your LMS. No student accounts.', tone: 'violet' },
  { icon: 'inbox', title: 'Collect', text: 'Students hand in an encrypted file or code. Import it.', tone: 'amber' },
  { icon: 'journal-check', title: 'Grade', text: 'Re-graded on your device, reviewed, synced to the gradebook.', tone: 'rose' },
  { icon: 'send', title: 'Report', text: 'Private grade links, PDFs, and a weekly backup.', tone: 'blue' }
];

const TONES = {
  emerald: 'bg-emerald-50 text-emerald-700',
  blue: 'bg-blue-50 text-blue-700',
  violet: 'bg-violet-50 text-violet-700',
  amber: 'bg-amber-50 text-amber-700',
  rose: 'bg-rose-50 text-rose-700'
};

const TOOLS = [
  { goal: 'Classes, student roster & access codes', tool: 'Classes', icon: 'people', tone: 'emerald', graded: 'Roster & sync management', handin: 'Access codes & QR cards', href: '#/classes' },
  { goal: 'Course units, syllabus & live feed', tool: 'Courses', icon: 'journal-bookmark', tone: 'blue', graded: 'Curriculum structure', handin: 'Zero-server public feeds', href: '#/course' },
  { goal: 'Unified schedule & calendar sync', tool: 'Calendar', icon: 'calendar3', tone: 'violet', graded: 'Due dates across all tools', handin: 'RFC 5545 iCalendar (.ics)', href: '#/calendar' },
  { goal: 'Automated file & zip submission intake', tool: 'Inbox', icon: 'inbox', tone: 'amber', graded: 'Staging & auto-import', handin: 'Watch folder & drag-and-drop', href: '#/inbox' },
  { goal: 'Quizzes, homework, exit tickets', tool: 'Assessments', icon: 'ui-checks', tone: 'amber', graded: 'Auto + manual for written answers', handin: 'Encrypted .kbsub file or pasted code', href: '#/assessments' },
  { goal: 'Watch a video and check understanding', tool: 'Video', icon: 'play-circle', tone: 'rose', graded: 'Auto (choice + keyword answers)', handin: 'Encrypted .kbr receipt', href: '#/video' },
  { goal: 'Labs, essays, projects, presentations', tool: 'Gradebook + rubric', icon: 'journal-check', tone: 'emerald', graded: 'By you, with rubric and comments', handin: 'However you collect work today', href: '#/gradebook' },
  { goal: 'Memorisation and spaced practice', tool: 'Flashcards', icon: 'stack', tone: 'blue', graded: 'Not graded (self-study)', handin: '—', href: '#/flashcards' },
  { goal: 'Chronology, cause and effect', tool: 'Timeline', icon: 'bar-chart-steps', tone: 'violet', graded: 'Not graded (explore / present)', handin: '—', href: '#/timeline' }
];

function steps(list) {
  return `
    <ol class="space-y-3">
      ${list.map((s, i) => `
        <li class="flex gap-3">
          <span class="flex-shrink-0 w-7 h-7 rounded-full bg-slate-100 text-slate-700 text-xs font-bold flex items-center justify-center tabular-nums">${i + 1}</span>
          <div class="min-w-0 pt-0.5">
            <p class="text-sm font-semibold text-slate-900">${s.title}</p>
            <p class="text-sm text-slate-600 leading-relaxed mt-0.5">${s.text}</p>
          </div>
        </li>`).join('')}
    </ol>`;
}

function tip(text, tone = 'blue', icon = 'lightbulb') {
  const cls = {
    blue: 'border-blue-200 bg-blue-50',
    amber: 'border-amber-200 bg-amber-50',
    emerald: 'border-emerald-200 bg-emerald-50'
  }[tone];
  const iconCls = { blue: 'text-blue-600', amber: 'text-amber-600', emerald: 'text-emerald-600' }[tone];
  return `<div class="rounded-xl border ${cls} p-4 flex gap-3"><sl-icon name="${icon}" class="${iconCls} text-lg flex-shrink-0 mt-0.5"></sl-icon><p class="text-sm text-slate-700 leading-relaxed">${text}</p></div>`;
}

function workflow({ id, icon, tone, title, when, list, actions = [], extra = '' }) {
  return `
    <section id="${id}" class="kb-guide-section bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-5 scroll-mt-24">
      <header class="flex items-start gap-4">
        <span class="w-11 h-11 rounded-xl ${TONES[tone]} flex items-center justify-center text-xl flex-shrink-0"><sl-icon name="${icon}"></sl-icon></span>
        <div class="min-w-0">
          <h2 class="text-xl font-bold text-slate-900">${title}</h2>
          <p class="text-sm text-slate-500 mt-1">${when}</p>
        </div>
      </header>
      ${steps(list)}
      ${extra}
      ${actions.length ? `
        <div class="flex flex-wrap gap-2 pt-4 border-t border-slate-100">
          ${actions.map((a, i) => `<sl-button size="small" ${i === 0 ? 'variant="primary"' : ''} href="${a.href}">${a.icon ? `<sl-icon slot="prefix" name="${a.icon}"></sl-icon>` : ''}${a.label}</sl-button>`).join('')}
        </div>` : ''}
    </section>`;
}

export async function renderGuideView(params, router, container) {
  container.innerHTML = `
    <div class="max-w-6xl mx-auto">
      <!-- Hero -->
      <section class="rounded-3xl border border-slate-200 bg-white p-6 sm:p-10 mb-8">
        <div class="max-w-3xl space-y-3">
          <span class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold"><sl-icon name="signpost-split"></sl-icon> Teacher guide</span>
          <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Recommended workflows</h1>
          <p class="text-base text-slate-600 leading-relaxed">How to set up a class, create and deliver work, collect it securely, grade it, and report back, without student accounts or a server. Everything stays on this device; students receive links and hand back encrypted files that only you can open.</p>
        </div>
      </section>

      <div class="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
        <!-- Table of contents -->
        <nav class="hidden lg:block" aria-label="Guide sections">
          <div class="sticky top-24 space-y-0.5">
            <p class="px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">On this page</p>
            ${SECTIONS.map(s => `
              <button type="button" class="kb-guide-toc w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 text-left transition-colors" data-target="${s.id}">
                <sl-icon name="${s.icon}" class="text-slate-400 flex-shrink-0"></sl-icon> <span class="truncate">${s.label}</span>
              </button>`).join('')}
          </div>
        </nav>

        <div class="space-y-8 min-w-0">
          <!-- 1. The loop -->
          <section id="guide-loop" class="kb-guide-section space-y-4 scroll-mt-24">
            <h2 class="text-xl font-bold text-slate-900">The weekly loop</h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              ${LOOP.map((l, i) => `
                <div class="bg-white rounded-2xl border border-slate-200 p-5 flex gap-4">
                  <span class="w-10 h-10 rounded-xl ${TONES[l.tone]} flex items-center justify-center text-lg flex-shrink-0"><sl-icon name="${l.icon}"></sl-icon></span>
                  <div>
                    <p class="text-sm font-semibold text-slate-900"><span class="text-slate-400 tabular-nums mr-1">${i + 1}.</span>${l.title}</p>
                    <p class="text-sm text-slate-600 mt-0.5 leading-relaxed">${l.text}</p>
                  </div>
                </div>`).join('')}
            </div>
          </section>

          <!-- 2. Setup -->
          ${workflow({
            id: 'guide-setup',
            icon: 'mortarboard',
            tone: 'emerald',
            title: 'Set up a class (once per section)',
            when: 'Do this before sharing anything. Each class section keeps its own roster, policies, grading scale and access codes.',
            list: [
              { title: 'Create the class', text: 'Gradebook → <strong>Actions → New Class…</strong>. Make one class per section or period, even for the same course, so rosters and grading scales stay separate. <strong>Clone Class Structure…</strong> copies categories and assignments to another section.' },
              { title: 'Add the roster', text: '<strong>Actions → Import Roster CSV…</strong> (name, student ID, email) or add students one at a time. Use the same student IDs as your school system; students type them when they hand in work.' },
              { title: 'Set categories and late policy', text: 'Open class settings (gear icon) → <strong>Categories &amp; policies</strong>. Set weights that add up to 100%, how many low scores to drop, how late work is penalised, and what missing work counts as.' },
              { title: 'Pick a grading scale', text: 'Class settings → <strong>Grading scale</strong>. Choose a preset (A–F, simple A–F, pass/fail, IB 1–7, Dutch 1–10) or edit the cut-offs. For standards-based grading, use the <strong>Standards</strong> tab instead.' },
              { title: 'Generate access codes', text: 'Class settings → <strong>Student access → Generate missing</strong>, then <strong>More → Print code slips</strong>. Hand each student their slip privately. The code unlocks their grade report and signs everything they hand in.' }
            ],
            extra: tip('Students who hand in work without a valid access code still appear, but are flagged so you can follow up. Regenerate a code any time a student loses theirs or it may have been shared.', 'amber', 'key'),
            actions: [{ label: 'Open Gradebook', href: '#/gradebook', icon: 'journal-check' }]
          })}

          <!-- 3. Choose a tool -->
          <section id="guide-tools" class="kb-guide-section space-y-4 scroll-mt-24">
            <div>
              <h2 class="text-xl font-bold text-slate-900">Choose the right tool</h2>
              <p class="text-sm text-slate-500 mt-1">Start from what you want students to do.</p>
            </div>
            <div class="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead class="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th class="text-left font-semibold px-5 py-3">If you want students to…</th>
                      <th class="text-left font-semibold px-5 py-3">Use</th>
                      <th class="text-left font-semibold px-5 py-3">Grading</th>
                      <th class="text-left font-semibold px-5 py-3">How work comes back</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${TOOLS.map(t => `
                      <tr class="border-t border-slate-100">
                        <td class="px-5 py-3 text-slate-800 font-medium">${t.goal}</td>
                        <td class="px-5 py-3 whitespace-nowrap">
                          <a href="${t.href}" class="inline-flex items-center gap-2 font-semibold text-slate-900 hover:text-blue-700">
                            <span class="w-7 h-7 rounded-lg ${TONES[t.tone]} flex items-center justify-center"><sl-icon name="${t.icon}"></sl-icon></span>${t.tool}
                          </a>
                        </td>
                        <td class="px-5 py-3 text-slate-600">${t.graded}</td>
                        <td class="px-5 py-3 text-slate-600">${t.handin}</td>
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <!-- 4. Assessments -->
          ${workflow({
            id: 'guide-assignments',
            icon: 'ui-checks',
            tone: 'amber',
            title: 'Auto-graded quizzes and assessments',
            when: 'Multiple choice, select-all, true/false, short answer, numeric, fill in the blank, ordering, matching and written responses.',
            list: [
              { title: 'Create and link it', text: 'Assessments → <strong>New Assessment</strong>. In Settings choose the class, gradebook category and due date so scores land in the right column and late work is marked automatically.' },
              { title: 'Write the questions', text: 'Add questions with <strong>Add question</strong>. Give partial credit where it makes sense, list accepted alternatives for short answers, and add an explanation students see after answering. Written responses are graded by you.' },
              { title: 'Choose feedback', text: '<strong>Score after submitting</strong> suits most homework. Use <strong>Instant, after each question</strong> for practice, and <strong>None until you return grades</strong> for tests. Leave “Show correct answers” off until everyone has submitted.' },
              { title: 'Preview, then publish', text: 'Use <strong>Preview</strong> to take it as a student. Then <strong>Publish &amp; share</strong> and post the link (or the .kbshare file) in your LMS. The link never contains the answer key.' },
              { title: 'Collect submissions', text: 'Students finish and hand in a <strong>submission file</strong> or <strong>submission code</strong> through your LMS. Nothing is sent automatically, so tell them where to upload it.' },
              { title: 'Import, review, sync', text: 'Open <strong>Submissions</strong> → <strong>Import .kbsub files</strong> or <strong>Paste codes</strong>. Every answer is re-graded with your key. Score the written answers, add feedback, then <strong>Sync to gradebook</strong>.' }
            ],
            extra: tip('If you edit questions after publishing, publish a new version and share the new link. Older submissions are still accepted and are labelled with their version.', 'blue', 'info-circle'),
            actions: [
              { label: 'New assessment', href: '#/assessments/edit', icon: 'plus-lg' },
              { label: 'Open Assessments', href: '#/assessments' }
            ]
          })}

          <!-- Delivery & Hand-in Matrix -->
          <section id="guide-assigning" class="kb-guide-section bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-6 scroll-mt-24">
            <header class="flex items-start gap-4">
              <span class="w-11 h-11 rounded-xl bg-violet-50 text-violet-700 flex items-center justify-center text-xl flex-shrink-0">
                <sl-icon name="diagram-3"></sl-icon>
              </span>
              <div class="min-w-0">
                <h2 class="text-xl font-bold text-slate-900">Assessment Delivery &amp; Hand-in Matrix</h2>
                <p class="text-sm text-slate-500 mt-1">Choose the optimal delivery and collection method for your classroom, school firewall, and LMS setup.</p>
              </div>
            </header>

            <!-- Delivery Methods Table -->
            <div class="space-y-3">
              <h3 class="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <sl-icon name="send" class="text-violet-600"></sl-icon> 1. Delivery Methods (How Students Open the Work)
              </h3>
              <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="w-full text-xs text-left">
                  <thead class="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200 uppercase tracking-wider">
                    <tr>
                      <th class="p-3">Delivery Method</th>
                      <th class="p-3">Format</th>
                      <th class="p-3">Best Used When</th>
                      <th class="p-3">Guarantees &amp; Trade-offs</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 text-slate-600">
                    <tr>
                      <td class="p-3 font-semibold text-slate-900">Standard Web Link (Fragment)</td>
                      <td class="p-3 font-mono text-[11px]">#/assessments/take#...</td>
                      <td class="p-3">Google Classroom, LMS assignments, student dashboards, email.</td>
                      <td class="p-3">Entire assignment is packed in the URL hash. 100% offline-ready once loaded. No backend or accounts required.</td>
                    </tr>
                    <tr>
                      <td class="p-3 font-semibold text-slate-900">Short Relay Link</td>
                      <td class="p-3 font-mono text-[11px]">https://relay.school.edu/s/...</td>
                      <td class="p-3">Character-limited messaging (SMS, Twitter, strict LMS link validators).</td>
                      <td class="p-3">Short URL redirected through your school relay server. Requires school server setup.</td>
                    </tr>
                    <tr>
                      <td class="p-3 font-semibold text-slate-900">Personalized Direct Link</td>
                      <td class="p-3 font-mono text-[11px]">?sid=STU101&amp;sname=Alice...</td>
                      <td class="p-3">Mail-merge emails, LMS personalized announcements.</td>
                      <td class="p-3">Student name &amp; ID auto-fill automatically. Student only types access code. Eliminates student typos.</td>
                    </tr>
                    <tr>
                      <td class="p-3 font-semibold text-slate-900">Offline .kbshare File</td>
                      <td class="p-3 font-mono text-[11px]">assignment.kbshare</td>
                      <td class="p-3">No internet access, air-gapped exams, or strict school content filters.</td>
                      <td class="p-3">Students open file directly in KennisBoost. Zero network traffic required.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Collection Methods Table -->
            <div class="space-y-3">
              <h3 class="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <sl-icon name="inbox" class="text-amber-600"></sl-icon> 2. Collection &amp; Hand-in Methods (How You Get Work Back)
              </h3>
              <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="w-full text-xs text-left">
                  <thead class="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200 uppercase tracking-wider">
                    <tr>
                      <th class="p-3">Collection Method</th>
                      <th class="p-3">Format</th>
                      <th class="p-3">How Teacher Collects</th>
                      <th class="p-3">Cryptographic Protection</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 text-slate-600">
                    <tr>
                      <td class="p-3 font-semibold text-slate-900">.kbsub File Download</td>
                      <td class="p-3 font-mono text-[11px]">student_work.kbsub</td>
                      <td class="p-3">Students submit file to LMS dropbox; teacher clicks <strong>Import .kbsub files</strong>.</td>
                      <td class="p-3">ECIES asymmetric encryption (AES-GCM + ECDH) + HMAC signature. Tamper-evident.</td>
                    </tr>
                    <tr>
                      <td class="p-3 font-semibold text-slate-900">Pasted Submission Code</td>
                      <td class="p-3 font-mono text-[11px]">KBSUB1.eyJrYnN1YiI6MS...</td>
                      <td class="p-3">Students paste text into LMS submission box or email; teacher clicks <strong>Paste codes</strong>.</td>
                      <td class="p-3">Identical ECIES security in base64url string format. Convenient for mobile devices.</td>
                    </tr>
                    <tr>
                      <td class="p-3 font-semibold text-slate-900">Relay Drop-Box Auto-Upload</td>
                      <td class="p-3 font-mono text-[11px]">Direct Relay Push</td>
                      <td class="p-3">Submissions appear live in your Inbox tab automatically when connected to school server.</td>
                      <td class="p-3">Drop-box only accepts encrypted envelopes; server cannot read answers or decrypt data.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- LMS Integration Recipes -->
            <div class="space-y-3">
              <h3 class="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <sl-icon name="journal-code" class="text-emerald-600"></sl-icon> 3. Step-by-Step LMS Recipes
              </h3>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div class="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                  <div class="font-bold text-slate-900 flex items-center gap-1.5"><sl-icon name="google" class="text-emerald-600"></sl-icon> Google Classroom</div>
                  <ol class="list-decimal pl-4 space-y-1 text-slate-600">
                    <li>Create <strong>Assignment</strong> in Classwork.</li>
                    <li>Paste the KennisBoost Student Link in instructions or as a Link attachment.</li>
                    <li>Instruct students to hand in their <code>.kbsub</code> file as the assignment attachment or paste their <code>KBSUB1.</code> code in private comments.</li>
                    <li>Download all files as a ZIP or copy codes, then click <strong>Import .kbsub files</strong> in KennisBoost.</li>
                  </ol>
                </div>
                <div class="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                  <div class="font-bold text-slate-900 flex items-center gap-1.5"><sl-icon name="circle-half" class="text-rose-600"></sl-icon> Canvas LMS</div>
                  <ol class="list-decimal pl-4 space-y-1 text-slate-600">
                    <li>Create an <strong>Assignment</strong>.</li>
                    <li>Set Submission Type to <strong>Online</strong> $\rightarrow$ check <strong>File Uploads</strong> (restrict extensions to <code>kbsub</code>) and/or <strong>Text Entry</strong>.</li>
                    <li>Put the Take link in the assignment description.</li>
                    <li>In Gradebook, click <strong>Download Submissions</strong> $\rightarrow$ drag the ZIP directly into KennisBoost Inbox.</li>
                  </ol>
                </div>
                <div class="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                  <div class="font-bold text-slate-900 flex items-center gap-1.5"><sl-icon name="microsoft" class="text-blue-600"></sl-icon> Microsoft Teams</div>
                  <ol class="list-decimal pl-4 space-y-1 text-slate-600">
                    <li>Create a new <strong>Assignment</strong> in Teams.</li>
                    <li>Add the KennisBoost Take link as a <strong>Link resource</strong>.</li>
                    <li>Instruct students to click "+ Add work" and upload their downloaded <code>.kbsub</code> file before clicking "Turn in".</li>
                    <li>Download submissions from Teams folder and import into KennisBoost.</li>
                  </ol>
                </div>
              </div>
            </div>
          </section>

          <!-- 5. Video -->
          ${workflow({
            id: 'guide-video',
            icon: 'play-circle',
            tone: 'rose',
            title: 'Interactive video lessons',
            when: 'Students watch a YouTube, Vimeo or MP4 video; it pauses at checkpoints they must answer before continuing.',
            list: [
              { title: 'Pick the video', text: 'Video → <strong>New Assessment</strong>. Paste a link (the provider is detected automatically) or start from <strong>Samples</strong>. Assign it to a class so students sign in with their access code.' },
              { title: 'Add checkpoints', text: 'Play the video and press <strong>Add Checkpoint Here</strong> right after the idea you want to check. Keep checkpoints short: one idea, two to four options. Notes are handy for “watch for…” prompts and are not scored.' },
              { title: 'Test it', text: '<strong>Test Kiosk View</strong> runs the student experience on your device.' },
              { title: 'Share', text: 'Use <strong>Share Lesson…</strong>. Keep “Show students right/wrong” on for practice; turn it off for graded checks so no answer hints are included.' },
              { title: 'Collect receipts', text: 'At the end students download a <strong>receipt</strong> (.kbr) or copy the receipt code and hand it in through your LMS.' },
              { title: 'Import into the gradebook', text: 'Gradebook → <strong>Actions → Import .kbr Video Receipts…</strong> → <strong>One column per video</strong>. Receipts are re-graded on your device and checked against each student\'s access code.' }
            ],
            actions: [
              { label: 'Open Video', href: '#/video', icon: 'play-circle' },
              { label: 'Open Gradebook', href: '#/gradebook' }
            ]
          })}

          <!-- 6. Rubrics / hand-graded -->
          ${workflow({
            id: 'guide-rubric',
            icon: 'grid-3x3',
            tone: 'violet',
            title: 'Hand-graded work with rubrics and feedback',
            when: 'Labs, essays, projects and presentations that you assess yourself.',
            list: [
              { title: 'Build the rubric once', text: 'Gradebook → <strong>Actions → Rubrics Designer…</strong>. Write short, observable descriptors for each level so students can see what the next level looks like.' },
              { title: 'Add the assignment', text: '<strong>+ Assignment</strong>, attach the rubric, and (optionally) align it to standards. Rubric points are scaled to the assignment\'s maximum automatically.' },
              { title: 'Grade student by student', text: 'Double-click (or right-click) a cell to open <strong>Grade details</strong>. Click a level for each criterion, add a comment where it helps, then use the down arrow to save and move to the next student.' },
              { title: 'Record status quickly', text: 'In any cell type a score, <kbd class="kb-kbd">M</kbd> for missing, <kbd class="kb-kbd">L</kbd> or <kbd class="kb-kbd">85L2</kbd> for late (with days), or <kbd class="kb-kbd">E</kbd> for excused. Late penalties follow the category policy.' }
            ],
            extra: tip('Feedback, rubric comments and standard comments all appear in the student\'s private grade report, so a sentence per criterion goes a long way.', 'emerald', 'chat-square-text'),
            actions: [{ label: 'Open Gradebook', href: '#/gradebook', icon: 'journal-check' }]
          })}

          <!-- 7. SBG -->
          ${workflow({
            id: 'guide-sbg',
            icon: 'bullseye',
            tone: 'blue',
            title: 'Standards-based grading',
            when: 'Report mastery per standard instead of averaging points.',
            list: [
              { title: 'Switch the class to standards-based', text: 'Class settings → <strong>General → Standards-based</strong>.' },
              { title: 'Add standards', text: 'Class settings → <strong>Standards → Import set</strong> (NGSS, Common Core), paste a list, or upload a CSV with code and description columns.' },
              { title: 'Agree on the scale', text: 'Set the proficiency labels (for example 4 Exceeds … 1 Beginning), the calculation method (power law rewards growth; most recent is simplest to explain), and how mastery converts to a report-card grade.' },
              { title: 'Score evidence', text: 'Create assignments with <strong>Proficiency</strong> scoring and align them to one or more standards. In Grade details, give a level per standard with a short comment.' },
              { title: 'Read the Standards view', text: 'Switch to <strong>Standards</strong> above the grid to see current mastery per student and standard; select a cell to see the evidence behind it.' }
            ],
            actions: [{ label: 'Open Gradebook', href: '#/gradebook', icon: 'bullseye' }]
          })}

          <!-- 8. Study -->
          ${workflow({
            id: 'guide-study',
            icon: 'stack',
            tone: 'blue',
            title: 'Study and review materials',
            when: 'Ungraded practice that students use on their own devices.',
            list: [
              { title: 'Flashcards', text: 'Build a deck with formulas, chemical equations and sketches. Share it from the deck menu; students study with spaced repetition and can practise with the Tower Defense game. Decks are not graded.' },
              { title: 'Timelines', text: 'Add events with dates (BCE supported) and categories. Present it in class from the canvas view, export an SVG for print, or share it from <strong>Export → Share Lesson Link</strong>.' },
              { title: 'Turn a timeline into practice', text: 'Timeline → <strong>Export → Create Flashcard Deck from Timeline</strong> gives students a ready-made recall deck.' }
            ],
            actions: [
              { label: 'Open Flashcards', href: '#/flashcards', icon: 'stack' },
              { label: 'Open Timeline', href: '#/timeline' }
            ]
          })}

          <!-- 9. Report -->
          ${workflow({
            id: 'guide-report',
            icon: 'send',
            tone: 'emerald',
            title: 'Report back to students and families',
            when: 'Each student sees only their own grades and feedback.',
            list: [
              { title: 'Private grade report links', text: 'Click a student\'s name → <strong>Create Encrypted Grade Report Link</strong>, or <strong>Actions → Encrypted Student Link…</strong>. The link is locked with the student\'s access code and shows grades, feedback, rubric comments and standards.' },
              { title: 'Send it privately', text: 'Use your LMS\'s private messages or school email. A report is a snapshot: send a fresh link after updating grades.' },
              { title: 'PDFs for conferences', text: '<strong>Actions → Print Student Report…</strong> for one student, or <strong>Export Roster Batch ZIP</strong> for the whole class.' }
            ],
            actions: [{ label: 'Open Gradebook', href: '#/gradebook', icon: 'journal-check' }]
          })}

          <!-- 10. Defaults -->
          <section id="guide-defaults" class="kb-guide-section bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-4 scroll-mt-24">
            <h2 class="text-xl font-bold text-slate-900">Recommended settings</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              ${[
                ['Practice and homework', 'Feedback after submitting (assignments) or instant right/wrong (videos). Show correct answers only after the due date.'],
                ['Quizzes and tests', 'No feedback until you return grades; video right/wrong off; access codes required.'],
                ['Due dates', 'Always set one; late submissions are flagged automatically using the category\'s late policy.'],
                ['Access codes', 'Generate them in the first week and print slips. Regenerate any code you think was shared.'],
                ['One class per section', 'Separate rosters, codes and grading scales per period; clone the structure to save time.'],
                ['Links in your LMS', 'Post links as assignments with a file-upload or text box so students have an obvious place to hand in.']
              ].map(([t, d]) => `
                <div class="flex gap-3 rounded-xl border border-slate-200 p-4">
                  <sl-icon name="check2-circle" class="text-emerald-600 text-lg flex-shrink-0 mt-0.5"></sl-icon>
                  <div><p class="text-sm font-semibold text-slate-900">${t}</p><p class="text-sm text-slate-600 mt-0.5 leading-relaxed">${d}</p></div>
                </div>`).join('')}
            </div>
          </section>

          <!-- 11. Safety -->
          <section id="guide-safety" class="kb-guide-section bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-4 scroll-mt-24">
            <div class="flex items-start gap-4">
              <span class="w-11 h-11 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center text-xl flex-shrink-0"><sl-icon name="shield-lock"></sl-icon></span>
              <div>
                <h2 class="text-xl font-bold text-slate-900">Keep your data safe</h2>
                <p class="text-sm text-slate-500 mt-1">Everything lives in this browser. That keeps student data private, and it also means backups are your job.</p>
              </div>
            </div>
            ${steps([
              { title: 'Back up weekly', text: 'Storage menu (top right) → <strong>Export JSON backup</strong>, or <strong>Set auto-sync file…</strong> to save automatically to a folder you already back up.' },
              { title: 'Use one browser profile', text: 'Submissions and receipts are encrypted for this browser\'s teacher key. Open them in the same browser profile you shared from, or restore your backup on the new device first. The key is included in backups.' },
              { title: 'Don\'t clear site data', text: 'Clearing cookies and site data for this app erases your classes. Export a backup first.' }
            ])}
            <div class="flex flex-wrap gap-2 pt-4 border-t border-slate-100">
              <sl-button size="small" variant="primary" id="guide-backup"><sl-icon slot="prefix" name="download"></sl-icon> Export a backup now</sl-button>
            </div>
          </section>

          <!-- 12. Connect to a school server -->
          <section id="guide-server" class="kb-guide-section bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-4 scroll-mt-24">
            <div class="flex items-start gap-4">
              <span class="w-11 h-11 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center text-xl flex-shrink-0"><sl-icon name="cloud-arrow-up"></sl-icon></span>
              <div>
                <h2 class="text-xl font-bold text-slate-900">Connect to a school server</h2>
                <p class="text-sm text-slate-500 mt-1">Optional: when your school hosts a KennisBoost relay server for short links and automatic hand-in.</p>
              </div>
            </div>
            ${steps([
              { title: 'Open server settings', text: 'Go to Backup & storage (top right) → <strong>Connect to a school server…</strong>.' },
              { title: 'Enter your credentials', text: 'Enter your server base URL (e.g. <code>https://relay.myschool.edu</code>) and your 64-character teacher bearer token provided by your school administrator.' },
              { title: 'Test and save', text: 'Click <strong>Test connection</strong> to verify server health and feature capabilities, then click <strong>Save</strong>.' },
              { title: 'What stays private', text: 'Zero-knowledge encryption is preserved. The server never sees lesson plaintext, student answers, or student names. Lessons are encrypted with random keys stored only in URL fragments, and student submissions are encrypted to your teacher key before transmission.' }
            ])}
            <div class="flex flex-wrap gap-2 pt-4 border-t border-slate-100">
              <sl-button size="small" href="#/about"><sl-icon slot="prefix" name="info-circle"></sl-icon> About KennisBoost</sl-button>
            </div>
          </section>

          <!-- Interactive FAQ -->
          <section id="guide-faq" class="kb-guide-section bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-6 scroll-mt-24">
            <header class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div class="flex items-start gap-4">
                <span class="w-11 h-11 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center text-xl flex-shrink-0">
                  <sl-icon name="patch-question"></sl-icon>
                </span>
                <div>
                  <h2 class="text-xl font-bold text-slate-900">Interactive FAQ</h2>
                  <p class="text-sm text-slate-500 mt-1">Instant answers on assignment editing, answer keys, student matching, and zero-trust security.</p>
                </div>
              </div>
              <div class="w-full sm:w-72">
                <sl-input id="faq-search" size="small" placeholder="Search questions &amp; keywords..." clearable>
                  <sl-icon slot="prefix" name="search"></sl-icon>
                </sl-input>
              </div>
            </header>

            <div id="faq-categories-container" class="space-y-6">
              <!-- Category 1 -->
              <div class="faq-category-block space-y-3">
                <h3 class="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <sl-icon name="pencil-square" class="text-amber-500"></sl-icon> Assessments, Versions &amp; Answer Keys
                </h3>
                <div class="space-y-2">
                  <details class="group bg-slate-50 rounded-xl border border-slate-200 px-5 py-4 transition-all" data-faq-item data-keywords="edit assignment answer key typo regrade reconcile manual override score feedback">
                    <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                      <span>What happens if I edit an assignment or fix an answer key after students submit?</span>
                      <sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                    </summary>
                    <div class="text-sm text-slate-600 leading-relaxed mt-2 pt-2 border-t border-slate-200/60">
                      When you open the <strong>Submissions Inbox</strong>, KennisBoost automatically reconciles all student submissions against the updated answer key using the students' original decrypted answers. Any manual score overrides or written comments you previously added are strictly preserved. The gradebook sync status is flagged so you can sync the updated scores with one click.
                    </div>
                  </details>

                  <details class="group bg-slate-50 rounded-xl border border-slate-200 px-5 py-4 transition-all" data-faq-item data-keywords="v2 publish update draft preserve answers wipe lost student">
                    <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                      <span>If I publish an updated version (v2), will students lose their in-progress drafts?</span>
                      <sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                    </summary>
                    <div class="text-sm text-slate-600 leading-relaxed mt-2 pt-2 border-t border-slate-200/60">
                      No! KennisBoost uses non-destructive cross-version draft migration. When a student opens a v2 link, it scans for their earlier drafts by stable question IDs and restores them into the v2 draft, displaying an <em>“Updated assignment loaded — your previous answers were preserved”</em> notice. Earlier draft files remain in local storage as backups.
                    </div>
                  </details>

                  <details class="group bg-slate-50 rounded-xl border border-slate-200 px-5 py-4 transition-all" data-faq-item data-keywords="answer key inspect element student link cheat instant feedback hash sha256">
                    <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                      <span>Can a student open browser DevTools to find the correct answers in the link?</span>
                      <sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                    </summary>
                    <div class="text-sm text-slate-600 leading-relaxed mt-2 pt-2 border-t border-slate-200/60">
                      No. The true answer key is never included in the published student payload. If you enable “Instant Feedback”, the payload contains only one-way cryptographic SHA-256 hashes of the answers, allowing the student's browser to verify their guess locally without revealing the solution. If instant feedback is disabled (e.g. for exams), no hashes are included at all.
                    </div>
                  </details>
                </div>
              </div>

              <!-- Category 2 -->
              <div class="faq-category-block space-y-3">
                <h3 class="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <sl-icon name="mortarboard" class="text-emerald-500"></sl-icon> Class Linking &amp; Roster Management
                </h3>
                <div class="space-y-2">
                  <details class="group bg-slate-50 rounded-xl border border-slate-200 px-5 py-4 transition-all" data-faq-item data-keywords="class linking roster guarantee sync gradebook course access code">
                    <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                      <span>What does linking an assignment to a class guarantee?</span>
                      <sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                    </summary>
                    <div class="text-sm text-slate-600 leading-relaxed mt-2 pt-2 border-t border-slate-200/60">
                      Linking binds the assignment to that course's roster, enables student identity verification via access codes, matches student names automatically, detects roster additions/removals with a staleness warning banner, and unlocks 1-click grade syncing directly into the gradebook.
                    </div>
                  </details>

                  <details class="group bg-slate-50 rounded-xl border border-slate-200 px-5 py-4 transition-all" data-faq-item data-keywords="name change nickname alias typo student id match suggested">
                    <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                      <span>What if a student changes their name, uses a nickname, or mistypes their ID?</span>
                      <sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                    </summary>
                    <div class="text-sm text-slate-600 leading-relaxed mt-2 pt-2 border-t border-slate-200/60">
                      KennisBoost's 5-stage student matcher resolves them automatically. First, it checks their cryptographic access code HMAC signature against roster cards. If a nickname was used, the inbox suggests the closest roster match. Clicking <strong>Link student</strong> saves the nickname as a permanent alias so all future work from that student links automatically.
                    </div>
                  </details>

                  <details class="group bg-slate-50 rounded-xl border border-slate-200 px-5 py-4 transition-all" data-faq-item data-keywords="duplicate work badge copy answers cheating same fingerprint">
                    <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                      <span>What does the “DUPLICATE ANSWERS” badge mean?</span>
                      <sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                    </summary>
                    <div class="text-sm text-slate-600 leading-relaxed mt-2 pt-2 border-t border-slate-200/60">
                      When two or more students submit an identical set of answers, KennisBoost computes matching cryptographic answer fingerprints and displays a <strong>DUPLICATE</strong> chip in the submissions table and review drawer, alerting you to potential collaboration or copying.
                    </div>
                  </details>
                </div>
              </div>

              <!-- Category 3 -->
              <div class="faq-category-block space-y-3">
                <h3 class="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <sl-icon name="shield-lock" class="text-violet-500"></sl-icon> Access Codes &amp; Cryptographic Security
                </h3>
                <div class="space-y-2">
                  <details class="group bg-slate-50 rounded-xl border border-slate-200 px-5 py-4 transition-all" data-faq-item data-keywords="rotate access code regenerate new code previous historical code mismatch">
                    <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                      <span>What happens when I rotate or regenerate a student's access code?</span>
                      <sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                    </summary>
                    <div class="text-sm text-slate-600 leading-relaxed mt-2 pt-2 border-t border-slate-200/60">
                      The previous code is safely stored in the student's rotation history. Submissions signed with an earlier access code remain verified with an explanatory note (<em>“Signed with previous access code”</em>), ensuring no past work is invalidated.
                    </div>
                  </details>

                  <details class="group bg-slate-50 rounded-xl border border-slate-200 px-5 py-4 transition-all" data-faq-item data-keywords="encryption local first zero trust privacy server relay ecies ec-dh aes-gcm">
                    <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                      <span>How does local-first zero-trust encryption work in practice?</span>
                      <sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                    </summary>
                    <div class="text-sm text-slate-600 leading-relaxed mt-2 pt-2 border-t border-slate-200/60">
                      All grading and scoring execute entirely inside your browser. Submissions are encrypted using ECIES (ECDH key exchange + AES-256-GCM). Only the teacher who published the assignment holds the private key in their browser's IndexedDB. School relay servers and cloud drops only carry encrypted blobs and cannot decrypt student names or answers.
                    </div>
                  </details>
                </div>
              </div>

              <!-- Category 4 -->
              <div class="faq-category-block space-y-3">
                <h3 class="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <sl-icon name="journal-bookmark" class="text-blue-500"></sl-icon> Student Gradebook &amp; Feedback Ledger
                </h3>
                <div class="space-y-2">
                  <details class="group bg-slate-50 rounded-xl border border-slate-200 px-5 py-4 transition-all" data-faq-item data-keywords="student gradebook feedback link ledger duplicate row history receipt kbsub">
                    <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                      <span>How do feedback links update the student's personal gradebook?</span>
                      <sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                    </summary>
                    <div class="text-sm text-slate-600 leading-relaxed mt-2 pt-2 border-t border-slate-200/60">
                      Feedback links contain stable course and assignment identifiers. When a student opens an updated feedback link (e.g. after a regrade or new comment), the student's ledger updates the existing record without creating duplicate entries, appending prior scores and comments to their revision timeline.
                    </div>
                  </details>

                  <details class="group bg-slate-50 rounded-xl border border-slate-200 px-5 py-4 transition-all" data-faq-item data-keywords="receipt proof submission download kbsub backup evidence dispute">
                    <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                      <span>Can students prove they submitted on time if a file gets lost?</span>
                      <sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                    </summary>
                    <div class="text-sm text-slate-600 leading-relaxed mt-2 pt-2 border-t border-slate-200/60">
                      Yes. When a student submits work, KennisBoost immediately records a cryptographic receipt ID, timestamp, and .kbsub backup directly in the student's IndexedDB. In the Student Gradebook (<code>#/gradebook/student</code>), students can view their submission receipt and re-download their <code>.kbsub</code> file at any time.
                    </div>
                  </details>
                </div>
              </div>
            </div>
          </section>

          <!-- 13. Troubleshooting -->
          <section id="guide-help" class="kb-guide-section space-y-3 scroll-mt-24">
            <h2 class="text-xl font-bold text-slate-900">Troubleshooting</h2>
            ${[
              ['“Encrypted for a different teacher key”', 'The file was made from a link you shared in another browser or device. Open it there, or restore that backup here.'],
              ['A student forgot their access code', 'Click the student → Access code → <strong>New code</strong>, give them the new code, and send fresh grade report links.'],
              ['A submission shows “Code mismatch”', 'It wasn\'t signed with that student\'s current code. Check with the student before importing; it may have been handed in by someone else.'],
              ['The link is very long', 'Standard links pack the lesson into the URL. If your LMS or email client cuts off long links, use a <strong>short link</strong> (hosted on a school relay server via Backup & storage → Connect to a school server) or share the <strong>.kbshare file</strong> instead.'],
              ['A video won\'t play', 'Check the link plays in a normal browser tab. Some YouTube videos disable embedding; pick another video or one of the samples.']
            ].map(([q, a]) => `
              <details class="group bg-white rounded-xl border border-slate-200 px-5 py-4">
                <summary class="flex items-center justify-between gap-3 cursor-pointer list-none text-sm font-semibold text-slate-900">
                  ${q}<sl-icon name="chevron-down" class="text-slate-400 transition-transform group-open:rotate-180 flex-shrink-0"></sl-icon>
                </summary>
                <p class="text-sm text-slate-600 leading-relaxed mt-2">${a}</p>
              </details>`).join('')}
          </section>
        </div>
      </div>
    </div>
  `;

  // Table of contents: smooth scroll + highlight the section in view
  const tocButtons = [...container.querySelectorAll('.kb-guide-toc')];
  tocButtons.forEach(btn => btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  let observer = null;
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((entries) => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      tocButtons.forEach(b => {
        const active = b.dataset.target === visible.target.id;
        b.classList.toggle('bg-blue-50', active);
        b.classList.toggle('text-blue-700', active);
        b.classList.toggle('font-semibold', active);
        if (active) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
    }, { rootMargin: '-80px 0px -65% 0px' });
    container.querySelectorAll('.kb-guide-section').forEach(sec => observer.observe(sec));
  }

  container.querySelector('#guide-backup')?.addEventListener('click', () => {
    document.getElementById('menu-btn-export-backup')?.click();
  });

  const faqSearch = container.querySelector('#faq-search');
  if (faqSearch) {
    const handleFaqFilter = (e) => {
      const q = (e.target.value || '').trim().toLowerCase();
      const items = container.querySelectorAll('[data-faq-item]');
      items.forEach(item => {
        if (!q) {
          item.classList.remove('hidden');
        } else {
          const text = (item.textContent || '').toLowerCase();
          const keywords = (item.dataset.keywords || '').toLowerCase();
          const match = text.includes(q) || keywords.includes(q);
          item.classList.toggle('hidden', !match);
          if (match) item.open = true;
        }
      });
      container.querySelectorAll('.faq-category-block').forEach(block => {
        const hasVisible = block.querySelectorAll('[data-faq-item]:not(.hidden)').length > 0;
        block.classList.toggle('hidden', !hasVisible);
      });
    };
    faqSearch.addEventListener('sl-input', handleFaqFilter);
    faqSearch.addEventListener('sl-clear', handleFaqFilter);
  }

  return () => observer?.disconnect();
}

export default renderGuideView;
