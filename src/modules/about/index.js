import { APP_VERSION, APP_REPOSITORY_URL } from '../../version.js';
import { loadDemoWorkspace, removeDemoData, hasDemoData } from '../../core/demo.js';
import { toast } from '../../utils/toast.js';

/**
 * About KennisBoost Tools View (#/about)
 */
export async function renderAboutView(params, router, container) {
  if (!container) return;

  const isDemoLoaded = await hasDemoData();

  container.innerHTML = `
    <div class="max-w-4xl mx-auto px-4 py-8 space-y-12">
      <!-- 1. Header & Introduction -->
      <section class="space-y-4">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center font-bold text-xl shadow-md">
            KB
          </div>
          <div>
            <h1 class="text-3xl font-extrabold text-slate-900 tracking-tight">About KennisBoost Tools</h1>
            <p class="text-sm font-medium text-slate-500">Version ${APP_VERSION} • Zero-server pedagogical toolkit</p>
          </div>
        </div>

        <p class="text-base text-slate-700 leading-relaxed pt-2">
          <strong>KennisBoost Tools</strong> is an offline-first suite of educational utilities designed for modern STEM classrooms.
          Built for teachers who care about privacy, longevity, and pedagogical craft, it provides rich interactive tools—including spaced repetition flashcards, multi-scale timelines, checkpoint video assessments, auto-graded assignments, and a standards-based gradebook—without requiring a remote database, paid subscriptions, or accounts.
        </p>
        <p class="text-base text-slate-700 leading-relaxed">
          Everything you create lives locally in your browser storage. Lesson content and student work are shared using cryptographic payloads embedded in secure web links or small portable files, ensuring student privacy by design.
        </p>
      </section>

      <!-- 2. Privacy & Data Architecture Model -->
      <section class="space-y-4">
        <div class="flex items-center gap-2 border-b border-slate-200 pb-2">
          <sl-icon name="shield-check" class="text-xl text-emerald-600"></sl-icon>
          <h2 class="text-xl font-bold text-slate-900">Privacy &amp; Data Security Model</h2>
        </div>
        <div class="overflow-x-auto rounded-xl border border-slate-200">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 text-xs font-semibold text-slate-700 border-b border-slate-200">
              <tr>
                <th class="p-3">Data Category</th>
                <th class="p-3">Where It Lives</th>
                <th class="p-3">What Leaves Your Device</th>
                <th class="p-3">What Students See</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 text-slate-600 text-xs">
              <tr>
                <td class="p-3 font-medium text-slate-900">Lesson Material</td>
                <td class="p-3">IndexedDB &amp; OPFS in your browser</td>
                <td class="p-3">Only links or exported files you actively share</td>
                <td class="p-3">Questions, prompts, multimedia</td>
              </tr>
              <tr>
                <td class="p-3 font-medium text-slate-900">Rosters &amp; Access Codes</td>
                <td class="p-3">Browser storage only</td>
                <td class="p-3">Never transmitted to any server</td>
                <td class="p-3">Their own private code on paper or in person</td>
              </tr>
              <tr>
                <td class="p-3 font-medium text-slate-900">Student Submissions</td>
                <td class="p-3">Browser storage after teacher import</td>
                <td class="p-3">Encrypted to teacher's public key (ECIES/AES-GCM)</td>
                <td class="p-3">Immediate score or submission receipt</td>
              </tr>
              <tr>
                <td class="p-3 font-medium text-slate-900">Gradebook Records</td>
                <td class="p-3">Local browser IndexedDB only</td>
                <td class="p-3">Only when exporting CSV / PDF reports</td>
                <td class="p-3">Individual encrypted progress reports</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 3. The Five Core Tools -->
      <section class="space-y-4">
        <div class="flex items-center gap-2 border-b border-slate-200 pb-2">
          <sl-icon name="tools" class="text-xl text-blue-600"></sl-icon>
          <h2 class="text-xl font-bold text-slate-900">The Five Core Tools</h2>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="p-4 rounded-xl border border-slate-200 bg-white hover:border-blue-300 transition-colors space-y-2">
            <div class="flex items-center justify-between">
              <span class="font-bold text-slate-900 flex items-center gap-2">
                <sl-icon name="stack" class="text-blue-600"></sl-icon> Spaced Repetition Flashcards
              </span>
              <sl-button size="small" variant="default" href="#/flashcards">Open</sl-button>
            </div>
            <p class="text-xs text-slate-600">Adaptive Leitner &amp; FSRS review player with LaTeX equations, chemistry notation, and drawing canvas.</p>
          </div>

          <div class="p-4 rounded-xl border border-slate-200 bg-white hover:border-violet-300 transition-colors space-y-2">
            <div class="flex items-center justify-between">
              <span class="font-bold text-slate-900 flex items-center gap-2">
                <sl-icon name="bar-chart-steps" class="text-violet-600"></sl-icon> Multi-Scale Timelines
              </span>
              <sl-button size="small" variant="default" href="#/timeline">Open</sl-button>
            </div>
            <p class="text-xs text-slate-600">Infinite logarithmic timeline zooming from cosmological eras down to nanoseconds, with SVG export.</p>
          </div>

          <div class="p-4 rounded-xl border border-slate-200 bg-white hover:border-rose-300 transition-colors space-y-2">
            <div class="flex items-center justify-between">
              <span class="font-bold text-slate-900 flex items-center gap-2">
                <sl-icon name="play-circle" class="text-rose-600"></sl-icon> Video Assessments
              </span>
              <sl-button size="small" variant="default" href="#/video">Open</sl-button>
            </div>
            <p class="text-xs text-slate-600">Interactive video check-ins for YouTube and HTML5 videos with tamper-evident cryptographic receipts.</p>
          </div>

          <div class="p-4 rounded-xl border border-slate-200 bg-white hover:border-amber-300 transition-colors space-y-2">
            <div class="flex items-center justify-between">
              <span class="font-bold text-slate-900 flex items-center gap-2">
                <sl-icon name="ui-checks" class="text-amber-600"></sl-icon> Assignments &amp; Hand-in
              </span>
              <sl-button size="small" variant="default" href="#/assignments">Open</sl-button>
            </div>
            <p class="text-xs text-slate-600">Auto-graded practice assignments covering 6 STEM question types with keyless student sharing.</p>
          </div>

          <div class="p-4 rounded-xl border border-slate-200 bg-white hover:border-emerald-300 transition-colors space-y-2 md:col-span-2">
            <div class="flex items-center justify-between">
              <span class="font-bold text-slate-900 flex items-center gap-2">
                <sl-icon name="journal-bookmark" class="text-emerald-600"></sl-icon> Multi-Class Gradebook
              </span>
              <sl-button size="small" variant="default" href="#/gradebook">Open</sl-button>
            </div>
            <p class="text-xs text-slate-600">Virtual 60fps gradebook supporting traditional weighted percentages and standards-based grading (SBG) with multi-tier rubrics.</p>
          </div>
        </div>
      </section>

      <!-- 4. How It Works -->
      <section class="space-y-4">
        <div class="flex items-center gap-2 border-b border-slate-200 pb-2">
          <sl-icon name="arrow-repeat" class="text-xl text-blue-600"></sl-icon>
          <h2 class="text-xl font-bold text-slate-900">How It Works</h2>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <div class="w-8 h-8 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center text-sm">1</div>
            <h3 class="font-bold text-slate-900 text-sm">Create &amp; Publish</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Build your assignment or video in the editor. Publish produces an encrypted link or file containing the questions.
            </p>
          </div>
          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <div class="w-8 h-8 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center text-sm">2</div>
            <h3 class="font-bold text-slate-900 text-sm">Student Takes Work</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Students open the link in any modern browser, answer questions, and download a small encrypted <code class="bg-white px-1 rounded">.kbsub</code> submission file.
            </p>
          </div>
          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <div class="w-8 h-8 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center text-sm">3</div>
            <h3 class="font-bold text-slate-900 text-sm">Collect &amp; Grade</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Drop student files into the Inbox. Submissions decrypt using your private teacher key and sync directly to your Gradebook.
            </p>
          </div>
        </div>
      </section>

      <!-- 5. Sample Data Management -->
      <section class="space-y-4">
        <div class="flex items-center gap-2 border-b border-slate-200 pb-2">
          <sl-icon name="box-seam" class="text-xl text-indigo-600"></sl-icon>
          <h2 class="text-xl font-bold text-slate-900">Explore with Sample Data</h2>
        </div>
        <div class="p-5 rounded-2xl border border-slate-200 bg-slate-50 flex flex-col md:flex-row items-center justify-between gap-4">
          <div>
            <h3 class="font-bold text-slate-900 text-sm">Interactive Sample Workspace</h3>
            <p class="text-xs text-slate-600 mt-1 max-w-lg">
              Populate your workspace with sample classes (AP Chemistry &amp; World History), students, flashcards, a timeline, a video checkpoint, and an assignment. Sample records can be removed anytime without affecting real work.
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <sl-button variant="primary" size="small" id="btn-about-load-demo">
              <sl-icon slot="prefix" name="box-arrow-in-down"></sl-icon> Load Sample Data
            </sl-button>
            <sl-button variant="danger" outline size="small" id="btn-about-remove-demo">
              <sl-icon slot="prefix" name="trash"></sl-icon> Remove Sample Data
            </sl-button>
          </div>
        </div>
      </section>

      <!-- 6. Keyboard Shortcuts & Documentation -->
      <section class="space-y-4">
        <div class="flex items-center gap-2 border-b border-slate-200 pb-2">
          <sl-icon name="command" class="text-xl text-slate-700"></sl-icon>
          <h2 class="text-xl font-bold text-slate-900">Keyboard Shortcuts &amp; Help</h2>
        </div>
        <div class="flex flex-wrap gap-3">
          <sl-button variant="default" size="small" id="btn-about-keyboard-shortcuts">
            <sl-icon slot="prefix" name="keyboard"></sl-icon> View Keyboard Shortcuts
          </sl-button>
          <sl-button variant="default" size="small" href="#/guide">
            <sl-icon slot="prefix" name="book"></sl-icon> Read Teacher Guide
          </sl-button>
          ${APP_REPOSITORY_URL ? `
            <sl-button variant="text" size="small" href="${APP_REPOSITORY_URL}" target="_blank">
              <sl-icon slot="prefix" name="github"></sl-icon> Source Code &amp; Issues
            </sl-button>
          ` : ''}
        </div>
      </section>

      <!-- 7. Open Source Credits -->
      <section class="space-y-4 pt-4 border-t border-slate-200 text-xs text-slate-500">
        <h3 class="font-bold text-slate-700 uppercase tracking-wider text-[11px]">Open Source Components &amp; Licences</h3>
        <p class="leading-relaxed">
          KennisBoost Tools is engineered using peer-reviewed, open-source libraries:
          Shoelace 2.15 (MIT), Dexie.js (Apache-2.0), KaTeX (MIT), DOMPurify (Apache-2.0 / MPL),
          marked (MIT), PapaParse (MIT), lz-string (MIT), jsPDF &amp; AutoTable (MIT),
          JSZip (MIT / GPL-3.0 dual), Zod (MIT), and Inter Font (OFL).
        </p>
      </section>
    </div>
  `;

  // Bind actions
  container.querySelector('#btn-about-load-demo')?.addEventListener('click', async () => {
    try {
      await loadDemoWorkspace();
      toast.success('Sample workspace loaded!');
    } catch (e) {
      toast.danger('Could not load sample data: ' + e.message);
    }
  });

  container.querySelector('#btn-about-remove-demo')?.addEventListener('click', async () => {
    try {
      await removeDemoData();
      toast.info('Sample data removed.');
    } catch (e) {
      toast.danger('Could not remove sample data: ' + e.message);
    }
  });

  container.querySelector('#btn-about-keyboard-shortcuts')?.addEventListener('click', () => {
    document.getElementById('menu-btn-keyboard-shortcuts')?.click();
  });
}

export default renderAboutView;
