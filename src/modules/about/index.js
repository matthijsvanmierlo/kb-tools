import { APP_VERSION, APP_REPOSITORY_URL } from '../../version.js';
import { loadDemoWorkspace, removeDemoData, hasDemoData } from '../../core/demo.js';
import { toast } from '../../utils/toast.js';
import { canInstallPwa, promptPwaInstall } from '../../core/pwa.js';

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

      <!-- 2. Local-First Philosophy & Privacy Architecture -->
      <section id="about-local-first-philosophy" class="space-y-6 pt-2 scroll-mt-20">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-3">
          <div class="flex items-center gap-2">
            <sl-icon name="shield-lock" class="text-2xl text-blue-600"></sl-icon>
            <div>
              <h2 class="text-xl font-bold text-slate-900">Local-First Philosophy &amp; Architecture</h2>
              <p class="text-xs text-slate-500">Why zero-server client-side software is better for education</p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <sl-button size="small" id="btn-philosophy-toggle-all" variant="default">
              <sl-icon slot="prefix" name="arrows-expand"></sl-icon>
              <span id="label-philosophy-toggle">Expand All</span>
            </sl-button>
          </div>
        </div>

        <!-- Executive Summary Card -->
        <div class="p-5 rounded-2xl bg-blue-50/70 border border-blue-200 text-slate-800 space-y-2">
          <div class="flex items-center gap-2 font-bold text-blue-900 text-sm">
            <sl-icon name="lightbulb" class="text-blue-600 text-base"></sl-icon>
            The Core Premise: Your Browser Is Your Server, Your Hardware Is Your Vault
          </div>
          <p class="text-xs sm:text-sm text-blue-950/80 leading-relaxed">
            Conventional educational software treats teachers and students as passive tenants on a vendor's remote cloud.
            <strong>KennisBoost Tools inverts this paradigm</strong>: your computing device runs the application natively, your local storage holds your data, and modern browser cryptography replaces cloud databases.
            Nothing is stored on our servers because <em>we don't run any servers</em>.
          </p>
        </div>

        <!-- 6 Expandable Pillar Cards -->
        <div class="space-y-3">
          <!-- Pillar 1 -->
          <sl-details class="kb-philosophy-detail border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
            <div slot="summary" class="font-bold text-slate-900 text-sm flex items-center gap-2">
              <sl-icon name="shield-check" class="text-emerald-600 text-base"></sl-icon>
              1. Privacy by Architectural Impossibility (Zero Server, Zero Telemetry)
            </div>
            <div class="text-xs sm:text-sm text-slate-600 space-y-2.5 pt-2 leading-relaxed">
              <p>
                In the cloud era, schools are constantly forced to sign Data Processing Agreements, conduct third-party risk assessments, and worry about data breaches exposing student records.
                In KennisBoost Tools, <strong>privacy is not a policy promise; it is an architectural guarantee</strong>.
              </p>
              <p>
                Because there is no central database or analytics backend, student profiles cannot be stolen, breached, sold to brokers, or profiled by AI models.
                Compliance with <strong>FERPA</strong>, <strong>GDPR / AVG</strong>, and <strong>COPPA</strong> is solved at the root: no Personally Identifiable Information (PII) ever leaves the student or teacher device.
              </p>
            </div>
          </sl-details>

          <!-- Pillar 2 -->
          <sl-details class="kb-philosophy-detail border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
            <div slot="summary" class="font-bold text-slate-900 text-sm flex items-center gap-2">
              <sl-icon name="person-check" class="text-blue-600 text-base"></sl-icon>
              2. Instant Convenience &amp; Zero Gatekeeping (No Accounts, No Passwords, No Subscriptions)
            </div>
            <div class="text-xs sm:text-sm text-slate-600 space-y-2.5 pt-2 leading-relaxed">
              <p>
                How much classroom instructional time is lost every year to forgotten passwords, email verification delays, SSO downtime, and district procurement red tape?
              </p>
              <p>
                With KennisBoost, neither teachers nor students create accounts. A student simply double-clicks a <code class="bg-slate-100 px-1 py-0.5 rounded text-slate-800">.kbshare.html</code> lesson file or follows a link, and they are immediately learning.
                Teachers don't need district IT approvals, credit card authorizations, or freemium license renewals to teach effectively.
              </p>
            </div>
          </sl-details>

          <!-- Pillar 3 -->
          <sl-details class="kb-philosophy-detail border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
            <div slot="summary" class="font-bold text-slate-900 text-sm flex items-center gap-2">
              <sl-icon name="wifi-off" class="text-amber-600 text-base"></sl-icon>
              3. 100% Offline Resilience &amp; Classroom Reliability
            </div>
            <div class="text-xs sm:text-sm text-slate-600 space-y-2.5 pt-2 leading-relaxed">
              <p>
                School Wi-Fi is notoriously brittle: bandwidth throttles during school-wide testing, connections drop in basement science labs, and students take laptops home to areas without internet.
              </p>
              <p>
                KennisBoost is engineered from the ground up using <strong>Service Workers</strong>, <strong>IndexedDB</strong>, and the <strong>Origin Private File System (OPFS)</strong>.
                Once loaded, every tool—from spaced-repetition flashcard drills and logarithmic timeline zoom to video checkpoints and assignment auto-grading—functions 100% offline. Exams and assignments never fail due to Wi-Fi drops.
              </p>
            </div>
          </sl-details>

          <!-- Pillar 4 -->
          <sl-details class="kb-philosophy-detail border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
            <div slot="summary" class="font-bold text-slate-900 text-sm flex items-center gap-2">
              <sl-icon name="archive" class="text-purple-600 text-base"></sl-icon>
              4. Long-Term Data Ownership &amp; Anti-Obsolescence
            </div>
            <div class="text-xs sm:text-sm text-slate-600 space-y-2.5 pt-2 leading-relaxed">
              <p>
                The EdTech graveyard is filled with beloved tools that were acquired, paywalled, or shut down, leaving teachers stranded with lost lesson plans and proprietary files they could no longer open.
              </p>
              <p>
                KennisBoost files belong exclusively to you. All decks, timelines, assignments, and grades export to open, standardized, human-readable formats: <code class="bg-slate-100 px-1 py-0.5 rounded text-slate-800">.html</code> (self-executing in any browser), <code class="bg-slate-100 px-1 py-0.5 rounded text-slate-800">.kbshare</code> (JSON envelopes), CSV spreadsheets, and printable PDFs.
                Even if the KennisBoost website were to disappear, your downloaded HTML launchers and CSV records will still open and execute in web browsers decades from now.
              </p>
            </div>
          </sl-details>

          <!-- Pillar 5 -->
          <sl-details class="kb-philosophy-detail border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
            <div slot="summary" class="font-bold text-slate-900 text-sm flex items-center gap-2">
              <sl-icon name="key" class="text-rose-600 text-base"></sl-icon>
              5. Cryptographic Trust Without a Central Server
            </div>
            <div class="text-xs sm:text-sm text-slate-600 space-y-2.5 pt-2 leading-relaxed">
              <p>
                How can an educational platform grade quizzes and collect student work securely without a backend server to guard the answers? <strong>Modern Web Cryptography</strong> replaces the database:
              </p>
              <ul class="list-disc pl-5 space-y-1.5">
                <li><strong>Keyless Assignment Publishing:</strong> Answers are hashed with unique salts (SHA-256) so students receive instant formative feedback without the answer key ever existing on their device in plaintext.</li>
                <li><strong>End-to-End Submission Encryption:</strong> When a student submits work (<code class="bg-slate-100 px-1 py-0.5 rounded text-slate-800">.kbsub</code>), the browser encrypts it to the teacher's NIST P-256 public key using ECDH + AES-256-GCM. Classmates, network sniffers, and LMS platforms cannot inspect student work.</li>
                <li><strong>Identity Verification:</strong> Passphrases and student access codes are validated using PBKDF2 HMAC hashes, giving teachers fraud-resistant proof of student identity without remote login accounts.</li>
              </ul>
            </div>
          </sl-details>

          <!-- Pillar 6 -->
          <sl-details class="kb-philosophy-detail border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
            <div slot="summary" class="font-bold text-slate-900 text-sm flex items-center gap-2">
              <sl-icon name="hdd-network" class="text-cyan-600 text-base"></sl-icon>
              6. Local-First Does Not Mean Isolated (Optional Sync &amp; School Relay)
            </div>
            <div class="text-xs sm:text-sm text-slate-600 space-y-2.5 pt-2 leading-relaxed">
              <p>
                Local-first does not mean single-device isolation. KennisBoost offers flexible, decentralized collaboration pathways:
              </p>
              <ul class="list-disc pl-5 space-y-1.5">
                <li><strong>Multi-Device Sync:</strong> Teachers can sync their gradebook and materials across work laptops and home desktops using local folder sync (e.g. Google Drive, OneDrive) or direct peer-to-peer WebRTC transfer.</li>
                <li><strong>Optional School Relay Server:</strong> Schools can deploy an ultra-lightweight, zero-knowledge relay server for 1-click short links and student drop-box hand-ins. Payloads remain fully end-to-end encrypted; the relay never sees plaintext data.</li>
              </ul>
            </div>
          </sl-details>
        </div>

        <!-- Cloud SaaS vs KennisBoost Local-First Comparison Matrix -->
        <div class="space-y-3 pt-4">
          <h3 class="text-xs font-bold text-slate-900 uppercase tracking-wider">Comparison: Cloud EdTech SaaS vs. KennisBoost Local-First</h3>
          <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table class="w-full text-left text-xs">
              <thead class="bg-slate-50 border-b border-slate-200 text-slate-700">
                <tr>
                  <th class="p-3">Attribute</th>
                  <th class="p-3 text-slate-500">Traditional Cloud EdTech SaaS</th>
                  <th class="p-3 text-blue-700 font-bold">KennisBoost Local-First</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 text-slate-600">
                <tr>
                  <td class="p-3 font-semibold text-slate-800">Data Storage</td>
                  <td class="p-3">Vendor cloud database / multi-tenant servers</td>
                  <td class="p-3 font-medium text-emerald-700">100% on your device (IndexedDB &amp; OPFS)</td>
                </tr>
                <tr>
                  <td class="p-3 font-semibold text-slate-800">Student Privacy</td>
                  <td class="p-3">Subject to data breaches, tracking, and PII storage</td>
                  <td class="p-3 font-medium text-emerald-700">Zero data collection; architecturally impossible to breach</td>
                </tr>
                <tr>
                  <td class="p-3 font-semibold text-slate-800">Account Friction</td>
                  <td class="p-3">Mandatory logins, emails, passwords, student accounts</td>
                  <td class="p-3 font-medium text-emerald-700">Zero accounts; double-click to launch in any browser</td>
                </tr>
                <tr>
                  <td class="p-3 font-semibold text-slate-800">Offline Capability</td>
                  <td class="p-3">Fails or degrades when school Wi-Fi is down</td>
                  <td class="p-3 font-medium text-emerald-700">Fully functional offline; Service Worker precached</td>
                </tr>
                <tr>
                  <td class="p-3 font-semibold text-slate-800">Vendor Lock-In</td>
                  <td class="p-3">Proprietary silos; lost when subscription expires</td>
                  <td class="p-3 font-medium text-emerald-700">Open formats (.html, .kbshare, CSV, JSON); forever accessible</td>
                </tr>
                <tr>
                  <td class="p-3 font-semibold text-slate-800">Cost &amp; Licensing</td>
                  <td class="p-3">Annual recurring per-seat subscription fees</td>
                  <td class="p-3 font-medium text-emerald-700">Free, open-source, client-side software</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Desktop App Installation (if PWA installable) -->
        <div id="about-pwa-install-card" class="p-4 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-4 ${canInstallPwa() ? '' : 'hidden'}">
          <div>
            <div class="font-bold text-slate-900 text-sm flex items-center gap-1.5">
              <sl-icon name="laptop" class="text-blue-600"></sl-icon> Install Desktop App
            </div>
            <div class="text-xs text-slate-500">Enable OS double-click launching for raw .kbshare and .kbsub files.</div>
          </div>
          <sl-button size="small" variant="primary" id="btn-about-install-pwa">
            <sl-icon slot="prefix" name="download"></sl-icon> Install Desktop App
          </sl-button>
        </div>
      </section>

      <!-- 3. Privacy & Data Architecture Model -->
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
          Shoelace 2.20 (MIT), Dexie.js (Apache-2.0), KaTeX (MIT), DOMPurify (Apache-2.0 / MPL),
          marked (MIT), PapaParse (MIT), lz-string (MIT), jsPDF &amp; AutoTable (MIT),
          JSZip (MIT / GPL-3.0 dual), Zod (MIT), qrcode-generator (MIT), jsQR (Apache-2.0),
          and Inter Font (OFL). Every library is served from this site; nothing loads from a CDN.
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

  // Bind Local-First Philosophy Interactions
  const philosophySection = container.querySelector('#about-local-first-philosophy');
  const toggleAllBtn = container.querySelector('#btn-philosophy-toggle-all');
  const toggleLabel = container.querySelector('#label-philosophy-toggle');
  const detailsList = container.querySelectorAll('.kb-philosophy-detail');

  const setAllDetails = (open) => {
    detailsList.forEach(d => {
      if (open) d.setAttribute('open', '');
      else d.removeAttribute('open');
    });
    if (toggleLabel) toggleLabel.textContent = open ? 'Collapse All' : 'Expand All';
    const icon = toggleAllBtn?.querySelector('sl-icon');
    if (icon) icon.name = open ? 'arrows-collapse' : 'arrows-expand';
  };

  let allOpen = false;
  toggleAllBtn?.addEventListener('click', () => {
    allOpen = !allOpen;
    setAllDetails(allOpen);
  });

  // If navigated directly to #/philosophy or #/about?section=philosophy
  const isPhilosophyRoute = (typeof window !== 'undefined' && window.location.hash.startsWith('#/philosophy')) || params?.section === 'philosophy';
  if (isPhilosophyRoute) {
    setAllDetails(true);
    allOpen = true;
    setTimeout(() => {
      philosophySection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }

  // Desktop App PWA Install action
  container.querySelector('#btn-about-install-pwa')?.addEventListener('click', async () => {
    await promptPwaInstall();
  });

  const onPwaInstallable = (e) => {
    const card = container.querySelector('#about-pwa-install-card');
    if (card) {
      if (e.detail) card.classList.remove('hidden');
      else card.classList.add('hidden');
    }
  };
  window.addEventListener('kb-pwa-installable', onPwaInstallable);
}

export default renderAboutView;
