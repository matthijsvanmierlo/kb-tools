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
  { id: 'guide-video', label: 'Video lessons', icon: 'play-circle' },
  { id: 'guide-rubric', label: 'Hand-graded work', icon: 'grid-3x3' },
  { id: 'guide-sbg', label: 'Standards-based', icon: 'bullseye' },
  { id: 'guide-study', label: 'Study & review', icon: 'stack' },
  { id: 'guide-report', label: 'Report back', icon: 'send' },
  { id: 'guide-defaults', label: 'Recommended settings', icon: 'check2-square' },
  { id: 'guide-safety', label: 'Keep data safe', icon: 'shield-lock' },
  { id: 'guide-server', label: 'Connect to a school server', icon: 'cloud-arrow-up' },
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
  { goal: 'Quizzes, homework, exit tickets', tool: 'Assignments', icon: 'ui-checks', tone: 'amber', graded: 'Auto + manual for written answers', handin: 'Encrypted .kbsub file or pasted code', href: '#/assignments' },
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

          <!-- 4. Assignments -->
          ${workflow({
            id: 'guide-assignments',
            icon: 'ui-checks',
            tone: 'amber',
            title: 'Auto-graded quizzes and homework',
            when: 'Multiple choice, select-all, true/false, short answer, numeric, fill in the blank, ordering, matching and written responses.',
            list: [
              { title: 'Create and link it', text: 'Assignments → <strong>New Assignment</strong>. In Settings choose the class, gradebook category and due date so scores land in the right column and late work is marked automatically.' },
              { title: 'Write the questions', text: 'Add questions with <strong>Add question</strong>. Give partial credit where it makes sense, list accepted alternatives for short answers, and add an explanation students see after answering. Written responses are graded by you.' },
              { title: 'Choose feedback', text: '<strong>Score after submitting</strong> suits most homework. Use <strong>Instant, after each question</strong> for practice, and <strong>None until you return grades</strong> for tests. Leave “Show correct answers” off until everyone has submitted.' },
              { title: 'Preview, then publish', text: 'Use <strong>Preview</strong> to take it as a student. Then <strong>Publish &amp; share</strong> and post the link (or the .kbshare file) in your LMS. The link never contains the answer key.' },
              { title: 'Collect submissions', text: 'Students finish and hand in a <strong>submission file</strong> or <strong>submission code</strong> through your LMS. Nothing is sent automatically, so tell them where to upload it.' },
              { title: 'Import, review, sync', text: 'Open <strong>Submissions</strong> → <strong>Import .kbsub files</strong> or <strong>Paste codes</strong>. Every answer is re-graded with your key. Score the written answers, add feedback, then <strong>Sync to gradebook</strong>.' }
            ],
            extra: tip('If you edit questions after publishing, publish a new version and share the new link. Older submissions are still accepted and are labelled with their version.', 'blue', 'info-circle'),
            actions: [
              { label: 'New assignment', href: '#/assignments/edit', icon: 'plus-lg' },
              { label: 'Open Assignments', href: '#/assignments' }
            ]
          })}

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

  return () => observer?.disconnect();
}

export default renderGuideView;
