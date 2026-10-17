import { storage } from '../../core/storage.js';
import { sync } from '../../core/sync.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { router } from '../../router.js';
import { toast } from '../../utils/toast.js';
import { generateUUID } from '../../utils/uuid.js';
import { ClassManager } from '../../components/class-manager.js';
import { ShareModal } from '../../components/share-dialog.js';

/**
 * Platform Home Page & Command Hub Controller
 */
export async function renderHomeView(params, r, container) {
  if (!container) return;

  // 1. Gather live IndexedDB statistics
  const [courses, students, decks, timelines, videos, assignmentSets, submissions] = await Promise.all([
    storage.table('gradebook_courses').toArray().catch(() => []),
    storage.table('gradebook_students').toArray().catch(() => []),
    storage.table('flashcards').toArray().catch(() => []),
    storage.table('timelines').toArray().catch(() => []),
    storage.table('video_assessments').toArray().catch(() => []),
    storage.table('assignments').toArray().catch(() => []),
    storage.table('assignment_submissions').toArray().catch(() => [])
  ]);
  const unsyncedSubmissions = submissions.filter(s => s.is_latest !== false && !s.synced_at).length;

  // Calculate cards due for FSRS review today
  const now = new Date();
  let dueCardsCount = 0;
  decks.forEach(d => {
    (d.cards || []).forEach(c => {
      if (c.fsrs?.due && new Date(c.fsrs.due) <= now) {
        dueCardsCount++;
      }
    });
  });

  const totalEvents = timelines.reduce((acc, t) => acc + (t.events?.length || 0), 0);
  const totalCheckpoints = videos.reduce((acc, v) => acc + (v.checkpoints?.length || 0), 0);

  // Storage quota
  const quota = await storage.checkStorageQuota();
  const lastBackup = await storage.getMetadata('last_backup_timestamp');

  // Filter projects if class filter is active
  const activeClassId = ClassManager.getActiveFilter();

  // Combine projects for "Continue Where You Left Off"
  const recentProjects = [
    ...decks.map(d => ({ ...d, _type: 'flashcards', _icon: 'stack', _badgeColor: 'blue', _openUrl: `#/flashcards/study?id=${d.id}`, _editUrl: `#/flashcards/edit?id=${d.id}` })),
    ...timelines.map(t => ({ ...t, _type: 'timeline', _icon: 'bar-chart-steps', _badgeColor: 'violet', _openUrl: `#/timeline/view?id=${t.id}`, _editUrl: `#/timeline/view?id=${t.id}` })),
    ...videos.map(v => ({ ...v, _type: 'video', _icon: 'play-circle', _badgeColor: 'rose', _openUrl: `#/video/kiosk?id=${v.id}`, _editUrl: `#/video/edit?id=${v.id}` })),
    ...assignmentSets.map(a => ({ ...a, _type: 'assignments', _icon: 'ui-checks', _badgeColor: 'amber', _openUrl: `#/assignments/edit?id=${a.id}`, _editUrl: `#/assignments/edit?id=${a.id}` }))
  ]
    .filter(p => !activeClassId || p.class_id === activeClassId)
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
    .slice(0, 4);

  // Format relative time helper
  const formatRelativeTime = (iso) => {
    if (!iso) return 'Recently';
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffHours = Math.floor(diffMs / 3600000);
    if (diffHours < 1) return 'Just now';
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  container.innerHTML = `
    <div class="space-y-8 max-w-7xl mx-auto pb-12">
      <!-- 1. Hero & Value Proposition Banner -->
      <section class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-600 via-indigo-700 to-slate-900 text-white p-6 sm:p-10 shadow-xl">
        <div class="relative z-10 max-w-3xl space-y-4">
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md text-xs font-semibold text-blue-200 border border-white/20">
            <sl-icon name="shield-check"></sl-icon> 100% Client-Side • Zero Cloud Dependency • FERPA Compliant
          </div>
          <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight text-white leading-tight">
            Privacy-First Teaching &amp; Learning Suite
          </h1>
          <p class="text-base sm:text-lg text-blue-100 leading-relaxed max-w-2xl">
            Author rich STEM flashcards with FSRS v4, build multi-scale interactive timelines, grade interactive videos with cryptographic receipts, and run 60 FPS offline gradebooks—without a single student account or cloud server.
          </p>

          <div class="flex flex-wrap items-center gap-3 pt-2">
            <sl-button variant="primary" size="medium" id="btn-seed-demo-workspace" class="kb-btn-hero">
              <sl-icon slot="prefix" name="stars"></sl-icon> Load demo workspace
            </sl-button>

            <sl-dropdown placement="bottom-start">
              <sl-button slot="trigger" variant="default" size="medium" caret class="kb-btn-glass">
                <sl-icon slot="prefix" name="plus-lg"></sl-icon> Create new
              </sl-button>
              <sl-menu>
                <sl-menu-item id="home-create-deck">
                  <sl-icon slot="prefix" name="stack" class="text-blue-600"></sl-icon> Flashcard Deck
                </sl-menu-item>
                <sl-menu-item id="home-create-timeline">
                  <sl-icon slot="prefix" name="bar-chart-steps" class="text-violet-600"></sl-icon> Interactive Timeline
                </sl-menu-item>
                <sl-menu-item id="home-create-video">
                  <sl-icon slot="prefix" name="play-circle" class="text-rose-600"></sl-icon> Video Assessment
                </sl-menu-item>
                <sl-menu-item id="home-create-assignment">
                  <sl-icon slot="prefix" name="ui-checks" class="text-amber-600"></sl-icon> Auto-graded Assignment
                </sl-menu-item>
                <sl-divider></sl-divider>
                <sl-menu-item id="home-create-class">
                  <sl-icon slot="prefix" name="mortarboard" class="text-emerald-600"></sl-icon> Course / Class
                </sl-menu-item>
              </sl-menu>
            </sl-dropdown>

            <sl-button variant="default" size="medium" id="btn-open-shared-file" class="kb-btn-glass" title="Open a .kbshare lesson or .kbr receipt">
              <sl-icon slot="prefix" name="folder2-open"></sl-icon> Open shared file
            </sl-button>
            <sl-button variant="text" size="medium" href="#/guide" class="kb-btn-hero-link">
              <sl-icon slot="prefix" name="signpost-split"></sl-icon> Teacher guide
            </sl-button>
            <input type="file" id="input-home-share-file" accept=".kbshare,.kbr,.json" class="hidden" />
          </div>
        </div>

        <!-- Decorative background glow -->
        <div class="absolute -right-20 -bottom-20 w-96 h-96 bg-blue-500/20 rounded-full blur-3xl pointer-events-none"></div>
      </section>

      <!-- 2. Live Workspace At-a-Glance Metrics Bar -->
      <section class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
        <!-- Classes Stat -->
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-col justify-between hover:shadow-md transition-all">
          <div class="flex items-center justify-between text-slate-500">
            <span class="text-xs font-semibold uppercase tracking-wider">Classes</span>
            <sl-icon name="mortarboard" class="text-emerald-600 text-lg"></sl-icon>
          </div>
          <div class="mt-2">
            <div class="text-2xl font-bold text-slate-900">${courses.length}</div>
            <div class="text-xs text-slate-500 mt-0.5">${students.length} students enrolled</div>
          </div>
          <a href="#/gradebook" class="text-xs font-medium text-blue-600 hover:text-blue-700 mt-3 inline-flex items-center gap-1">
            Open Gradebook &rarr;
          </a>
        </div>

        <!-- Flashcards Stat -->
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-col justify-between hover:shadow-md transition-all">
          <div class="flex items-center justify-between text-slate-500">
            <span class="text-xs font-semibold uppercase tracking-wider">Flashcards</span>
            <sl-icon name="stack" class="text-blue-600 text-lg"></sl-icon>
          </div>
          <div class="mt-2">
            <div class="text-2xl font-bold text-slate-900">${decks.length}</div>
            <div class="text-xs ${dueCardsCount > 0 ? 'text-amber-600 font-bold' : 'text-slate-500'} mt-0.5">
              ${dueCardsCount > 0 ? `⚡ ${dueCardsCount} due for FSRS review` : 'All caught up!'}
            </div>
          </div>
          <a href="#/flashcards" class="text-xs font-medium text-blue-600 hover:text-blue-700 mt-3 inline-flex items-center gap-1">
            ${dueCardsCount > 0 ? 'Study Due Cards &rarr;' : 'Open Decks &rarr;'}
          </a>
        </div>

        <!-- Timelines Stat -->
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-col justify-between hover:shadow-md transition-all">
          <div class="flex items-center justify-between text-slate-500">
            <span class="text-xs font-semibold uppercase tracking-wider">Timelines</span>
            <sl-icon name="bar-chart-steps" class="text-violet-600 text-lg"></sl-icon>
          </div>
          <div class="mt-2">
            <div class="text-2xl font-bold text-slate-900">${timelines.length}</div>
            <div class="text-xs text-slate-500 mt-0.5">${totalEvents} historical events</div>
          </div>
          <a href="#/timeline" class="text-xs font-medium text-blue-600 hover:text-blue-700 mt-3 inline-flex items-center gap-1">
            Explore Timelines &rarr;
          </a>
        </div>

        <!-- Video Assessments Stat -->
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-col justify-between hover:shadow-md transition-all">
          <div class="flex items-center justify-between text-slate-500">
            <span class="text-xs font-semibold uppercase tracking-wider">Videos</span>
            <sl-icon name="play-circle" class="text-rose-600 text-lg"></sl-icon>
          </div>
          <div class="mt-2">
            <div class="text-2xl font-bold text-slate-900">${videos.length}</div>
            <div class="text-xs text-slate-500 mt-0.5">${totalCheckpoints} active checkpoints</div>
          </div>
          <a href="#/video" class="text-xs font-medium text-blue-600 hover:text-blue-700 mt-3 inline-flex items-center gap-1">
            Video Hub &rarr;
          </a>
        </div>

        <!-- Assignments Stat -->
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-col justify-between hover:shadow-md transition-all">
          <div class="flex items-center justify-between text-slate-500">
            <span class="text-xs font-semibold uppercase tracking-wider">Assignments</span>
            <sl-icon name="ui-checks" class="text-amber-600 text-lg"></sl-icon>
          </div>
          <div class="mt-2">
            <div class="text-2xl font-bold text-slate-900">${assignmentSets.length}</div>
            <div class="text-xs ${unsyncedSubmissions ? 'text-amber-600 font-semibold' : 'text-slate-500'} mt-0.5">${unsyncedSubmissions ? `${unsyncedSubmissions} submission${unsyncedSubmissions === 1 ? '' : 's'} to review` : `${submissions.length} submissions received`}</div>
          </div>
          <a href="#/assignments" class="text-xs font-medium text-blue-600 hover:text-blue-700 mt-3 inline-flex items-center gap-1">
            Open Assignments &rarr;
          </a>
        </div>

        <!-- Storage & Sync Health -->
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-col justify-between hover:shadow-md transition-all">
          <div class="flex items-center justify-between text-slate-500">
            <span class="text-xs font-semibold uppercase tracking-wider">Data Health</span>
            <sl-icon name="shield-lock" class="text-indigo-600 text-lg"></sl-icon>
          </div>
          <div class="mt-2">
            <div class="text-sm font-bold text-slate-900 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-500"></span> Persistent Storage
            </div>
            <div class="text-[11px] text-slate-500 mt-0.5">
              ${quota ? `${quota.usageMB} MB used` : 'Local IndexedDB'}
            </div>
          </div>
          <button id="home-backup-now" class="text-xs font-semibold text-left text-blue-600 hover:text-blue-700 mt-3 inline-flex items-center gap-1">
            <sl-icon name="download"></sl-icon> Backup JSON
          </button>
        </div>
      </section>

      <!-- 3. Continue Where You Left Off (Recent Projects) -->
      <section class="space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-bold text-slate-900 flex items-center gap-2">
              <sl-icon name="arrow-repeat" class="text-blue-600"></sl-icon> Continue Where You Left Off
            </h2>
            <p class="text-xs text-slate-500">Your most recently modified projects across all tools</p>
          </div>
          ${activeClassId ? `
            <div class="text-xs text-slate-600 bg-slate-100 px-2.5 py-1 rounded-full flex items-center gap-1.5">
              <span>Filtered by Class:</span>
              <span class="font-semibold text-slate-900">${Sanitizer.escapeHTML(courses.find(c => c.id === activeClassId)?.name || '')}</span>
            </div>
          ` : ''}
        </div>

        ${recentProjects.length === 0 ? `
          <div class="p-8 text-center bg-white rounded-2xl border border-dashed border-slate-300 space-y-3">
            <sl-icon name="folder2-open" class="text-3xl text-slate-400"></sl-icon>
            <p class="text-sm text-slate-600">No projects found. Get started by exploring the demo workspace or creating a new deck!</p>
            <sl-button variant="primary" size="small" id="btn-seed-empty-recent">Load Demo Materials</sl-button>
          </div>
        ` : `
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            ${recentProjects.map(p => {
              const assignedClass = courses.find(c => c.id === p.class_id);
              const safeTitle = Sanitizer.escapeHTML(p.title || 'Untitled');
              return `
                <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs hover:shadow-md transition-all flex flex-col justify-between space-y-3">
                  <div class="space-y-2">
                    <div class="flex items-center justify-between">
                      <span class="w-9 h-9 rounded-xl flex items-center justify-center bg-${p._badgeColor}-50 text-${p._badgeColor}-600 text-lg">
                        <sl-icon name="${p._icon}"></sl-icon>
                      </span>
                      <span class="text-[10px] text-slate-400 font-mono">${formatRelativeTime(p.updated_at)}</span>
                    </div>

                    <div>
                      <h3 class="font-bold text-slate-900 text-sm line-clamp-2" title="${safeTitle}">${safeTitle}</h3>
                      <div class="mt-1 flex items-center gap-1.5 flex-wrap">
                        ${assignedClass ? ClassManager.renderClassBadge(assignedClass) : `
                          <span class="text-[10px] text-slate-400">Unassigned</span>
                        `}
                      </div>
                    </div>
                  </div>

                  <div class="pt-2 border-t border-slate-100 flex items-center justify-between">
                    <sl-button size="small" variant="primary" class="flex-1 mr-2" onclick="window.location.hash='${p._openUrl}'">
                      Open
                    </sl-button>
                    <sl-button size="small" variant="default" data-action="share-project" data-type="${p._type}" data-id="${p.id}" title="Share">
                      <sl-icon name="share"></sl-icon>
                    </sl-button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </section>

      <!-- 4. Interactive Feature Showcase (The 4 Core Tools) -->
      <section class="space-y-4">
        <div>
          <h2 class="text-lg font-bold text-slate-900">Platform Core Capabilities</h2>
          <p class="text-xs text-slate-500">Five interconnected zero-backend tools engineered for privacy, rigor, and speed</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Flashcards Card -->
          <div class="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs hover:border-blue-400 transition-all flex flex-col justify-between space-y-4">
            <div class="space-y-3">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-xl">
                  <sl-icon name="stack"></sl-icon>
                </div>
                <div>
                  <h3 class="font-bold text-slate-900 text-base">Flashcards &amp; Spaced Repetition</h3>
                  <p class="text-xs text-slate-500">FSRS v4 Cognitive Scheduler &bull; STEM Math &bull; Vector Drawing</p>
                </div>
              </div>
              <p class="text-xs text-slate-600 leading-relaxed">
                Modern replacement for Anki with the Free Spaced Repetition Scheduler (FSRS v4), KaTeX formulas, chemical notation, pressure-sensitive vector sketch pad, multi-language TTS, and an integrated 60 FPS Tower Defense study game.
              </p>
              <div class="flex flex-wrap gap-1.5 text-[11px] text-slate-600">
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">FSRS v4</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">KaTeX + Mhchem</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">Vector Canvas</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">Tower Defense</span>
              </div>
            </div>
            <div class="pt-3 border-t border-slate-100 flex items-center gap-2">
              <sl-button variant="primary" size="small" onclick="window.location.hash='#/flashcards'">Launch Flashcards</sl-button>
              <sl-button variant="default" size="small" onclick="window.location.hash='#/flashcards/edit'">Create New Deck</sl-button>
            </div>
          </div>

          <!-- Timeline Card -->
          <div class="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs hover:border-violet-400 transition-all flex flex-col justify-between space-y-4">
            <div class="space-y-3">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-violet-100 text-violet-600 flex items-center justify-center text-xl">
                  <sl-icon name="bar-chart-steps"></sl-icon>
                </div>
                <div>
                  <h3 class="font-bold text-slate-900 text-base">Interactive Timeline Engine</h3>
                  <p class="text-xs text-slate-500">Astronomical BCE-to-Future Scale &bull; Zero-Collision Anti-Overlap</p>
                </div>
              </div>
              <p class="text-xs text-slate-600 leading-relaxed">
                Explore history from 5000 BCE to the far future. Features multi-scale semantic zoom (hours to centuries), calendar-aligned snapping, automatic greedy lane packing, and standalone Vector SVG export for print publications.
              </p>
              <div class="flex flex-wrap gap-1.5 text-[11px] text-slate-600">
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">BCE/CE Historical Parser</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">Multi-Scale Semantic Zoom</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">Vector SVG Export</span>
              </div>
            </div>
            <div class="pt-3 border-t border-slate-100 flex items-center gap-2">
              <sl-button variant="primary" size="small" onclick="window.location.hash='#/timeline'">Open Timelines</sl-button>
            </div>
          </div>

          <!-- Video Card -->
          <div class="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs hover:border-rose-400 transition-all flex flex-col justify-between space-y-4">
            <div class="space-y-3">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center text-xl">
                  <sl-icon name="play-circle"></sl-icon>
                </div>
                <div>
                  <h3 class="font-bold text-slate-900 text-base">Video Assessment Platform</h3>
                  <p class="text-xs text-slate-500">Anti-Scrub Gatekeeper &bull; Tamper-Proof Cryptographic Receipts</p>
                </div>
              </div>
              <p class="text-xs text-slate-600 leading-relaxed">
                Turn any YouTube, Vimeo, or HTML5 video into an interactive checkpoint quiz. Enforces playhead gatekeeping so students cannot skip content, and issues SHA-256 signed <code class="text-xs">.kbr</code> receipts verifiable offline in the Gradebook.
              </p>
              <div class="flex flex-wrap gap-1.5 text-[11px] text-slate-600">
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">Multi-Choice &amp; Open Response</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">YouTube / Vimeo / MP4</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">SHA-256 Receipts</span>
              </div>
            </div>
            <div class="pt-3 border-t border-slate-100 flex items-center gap-2">
              <sl-button variant="primary" size="small" onclick="window.location.hash='#/video'">Open Video Hub</sl-button>
            </div>
          </div>

          <!-- Assignments Card -->
          <div class="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs hover:border-amber-400 transition-all flex flex-col justify-between space-y-4">
            <div class="space-y-3">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center text-xl">
                  <sl-icon name="ui-checks"></sl-icon>
                </div>
                <div>
                  <h3 class="font-bold text-slate-900 text-base">Auto-graded Assignments</h3>
                  <p class="text-xs text-slate-500">8 Question Types &bull; Instant Feedback &bull; Encrypted Hand-in</p>
                </div>
              </div>
              <p class="text-xs text-slate-600 leading-relaxed">
                Multiple choice, fill in the blank, ordering, matching, numeric and written responses with partial credit. Students hand in an encrypted, access-code-signed submission that only you can open; every submission is re-graded on your device before it reaches the gradebook.
              </p>
              <div class="flex flex-wrap gap-1.5 text-[11px] text-slate-600">
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">Partial Credit</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">No Answer Keys in Links</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">Gradebook Sync</span>
              </div>
            </div>
            <div class="pt-3 border-t border-slate-100 flex items-center gap-2">
              <sl-button variant="primary" size="small" onclick="window.location.hash='#/assignments'">Open Assignments</sl-button>
              <sl-button variant="default" size="small" onclick="window.location.hash='#/assignments/edit'">Create Assignment</sl-button>
            </div>
          </div>

          <!-- Gradebook Card -->
          <div class="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs hover:border-emerald-400 transition-all flex flex-col justify-between space-y-4">
            <div class="space-y-3">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center text-xl">
                  <sl-icon name="journal-check"></sl-icon>
                </div>
                <div>
                  <h3 class="font-bold text-slate-900 text-base">Multi-Class Browser Gradebook</h3>
                  <p class="text-xs text-slate-500">60 FPS Virtual Grid &bull; Traditional &amp; SBG &bull; Rubric Click-Scorer</p>
                </div>
              </div>
              <p class="text-xs text-slate-600 leading-relaxed">
                Spreadsheet-grade educator gradebook with 20-step undo/redo, single-key missing/late/exempt shortcuts, weighted categories with drop-lowest policy, interactive Rubric Scorer, and direct receipt import from Video Assessments.
              </p>
              <div class="flex flex-wrap gap-1.5 text-[11px] text-slate-600">
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">Weighted &amp; Standards-Based</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">Interactive Rubrics</span>
                <span class="px-2 py-0.5 bg-slate-100 rounded-md font-medium">Batch PDF Reports</span>
              </div>
            </div>
            <div class="pt-3 border-t border-slate-100 flex items-center gap-2">
              <sl-button variant="primary" size="small" onclick="window.location.hash='#/gradebook'">Launch Gradebook</sl-button>
            </div>
          </div>
        </div>
      </section>

      <!-- 5. How It Works: Teacher & Student Workflow Guide -->
      <section class="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-xs space-y-6">
        <div>
          <h2 class="text-lg font-bold text-slate-900">How It Works: Zero-Server Teaching &amp; Learning</h2>
          <p class="text-xs text-slate-500">The entire lifecycle happens privately on your device and student devices</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 relative">
          <!-- Step 1 -->
          <div class="space-y-2">
            <div class="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 font-bold flex items-center justify-center text-sm border border-blue-200">
              1
            </div>
            <h3 class="font-semibold text-slate-900 text-sm">Organize &amp; Author</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Create courses, build STEM flashcard decks with KaTeX formulas, place timeline milestones, and set video checkpoint questions. Everything auto-saves in your browser's private IndexedDB database.
            </p>
          </div>

          <!-- Step 2 -->
          <div class="space-y-2">
            <div class="w-9 h-9 rounded-xl bg-violet-50 text-violet-600 font-bold flex items-center justify-center text-sm border border-violet-200">
              2
            </div>
            <h3 class="font-semibold text-slate-900 text-sm">Share Zero-Server Links</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Generate self-contained URLs or download tiny <code class="text-xs">.kbshare</code> files with optional AES-256 encryption. Post the links directly to Google Classroom, Canvas, or email—no student accounts or backend servers required.
            </p>
          </div>

          <!-- Step 3 -->
          <div class="space-y-2">
            <div class="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 font-bold flex items-center justify-center text-sm border border-emerald-200">
              3
            </div>
            <h3 class="font-semibold text-slate-900 text-sm">Assess &amp; Verify Offline</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Students open the link to study or complete video assessments in distraction-free Kiosk mode. Students return cryptographic <code class="text-xs">.kbr</code> receipts, which you import into your Gradebook with 1 click.
            </p>
          </div>
        </div>
      </section>
    </div>
  `;

  // Bind Event Handlers
  container.querySelector('#home-create-deck')?.addEventListener('click', () => router.navigate('#/flashcards/edit'));
  container.querySelector('#home-create-timeline')?.addEventListener('click', () => router.navigate('#/timeline'));
  container.querySelector('#home-create-video')?.addEventListener('click', () => router.navigate('#/video'));
  container.querySelector('#home-create-assignment')?.addEventListener('click', () => router.navigate('#/assignments/edit'));
  container.querySelector('#home-create-class')?.addEventListener('click', () => {
    ClassManager.openClassEditorModal(null, () => renderHomeView(params, r, container));
  });

  container.querySelector('#home-backup-now')?.addEventListener('click', async () => {
    await sync.exportManualBackup();
  });

  // Share quick button
  container.querySelectorAll('[data-action="share-project"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      const id = btn.dataset.id;
      let project = null;
      if (type === 'flashcards') project = await storage.table('flashcards').get(id);
      else if (type === 'timeline') project = await storage.table('timelines').get(id);
      else if (type === 'video') project = await storage.table('video_assessments').get(id);

      if (project) {
        ShareModal.open(project, type);
      }
    });
  });

  // Open shared file (.kbshare / .kbr)
  const shareFileInput = container.querySelector('#input-home-share-file');
  container.querySelector('#btn-open-shared-file')?.addEventListener('click', () => {
    shareFileInput?.click();
  });

  shareFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      if (json.receipt && json.signature) {
        // It's a student video receipt (.kbr)
        toast.info('Student assessment receipt detected. Opening Gradebook receipt import...');
        router.navigate('#/gradebook');
      } else if (json.d) {
        // It's a .kbshare payload
        const encParam = json.enc ? '1' : '0';
        router.navigate(`#/share?enc=${encParam}&d=${json.d}`);
      } else {
        toast.warning('Unrecognized file structure.');
      }
    } catch (err) {
      toast.danger('Invalid or corrupted file.');
    } finally {
      shareFileInput.value = '';
    }
  });

  // Seed demo workspace handler
  const seedDemoWorkspace = async () => {
    const seedBtn = container.querySelector('#btn-seed-demo-workspace');
    seedBtn?.setAttribute('loading', '');

    try {
      // 1. Seed Courses
      const apChem = await ClassManager.saveClass({
        name: 'AP Chemistry',
        section: 'Period 2 • Lab 104',
        academic_year: '2026-2027',
        color: '#2563eb'
      });

      const worldHistory = await ClassManager.saveClass({
        name: 'World History & Civilizations',
        section: 'Period 4 • Room 202',
        academic_year: '2026-2027',
        color: '#7c3aed'
      });

      // 2. Seed Students in AP Chemistry
      const studentsTable = storage.table('gradebook_students');
      const student1 = { id: generateUUID(), course_id: apChem.id, student_id: 'CHEM-001', full_name: 'Sophia Patel', email: 'spatel@school.edu' };
      const student2 = { id: generateUUID(), course_id: apChem.id, student_id: 'CHEM-002', full_name: 'Marcus Chen', email: 'mchen@school.edu' };
      const student3 = { id: generateUUID(), course_id: apChem.id, student_id: 'CHEM-003', full_name: 'Elena Rostova', email: 'erostova@school.edu' };
      await Promise.all([studentsTable.put(student1), studentsTable.put(student2), studentsTable.put(student3)]);

      // 2b. Seed assignments and grades so the gradebook demo has real data
      const [catAssess, catClasswork] = apChem.categories;
      const termId = apChem.terms[0].id;
      const chemAssignments = [
        { id: generateUUID(), course_id: apChem.id, term_id: termId, category_id: catAssess.id, title: 'Unit 1 Exam: Atomic Structure', max_score: 100, due_date: '2026-09-25' },
        { id: generateUUID(), course_id: apChem.id, term_id: termId, category_id: catClasswork.id, title: 'Stoichiometry Lab', max_score: 50, due_date: '2026-10-05' },
        { id: generateUUID(), course_id: apChem.id, term_id: termId, category_id: catClasswork.id, title: 'Mole Concept Homework', max_score: 20, due_date: '2026-10-10' },
        { id: generateUUID(), course_id: apChem.id, term_id: termId, category_id: catAssess.id, title: 'Unit 2 Quiz: Bonding', max_score: 40, due_date: '2026-10-24' }
      ];
      await storage.table('gradebook_assignments').bulkPut(chemAssignments);

      const grade = (student, idx, raw_score, status = 'submitted', extra = {}) => ({
        course_id: apChem.id, student_id: student.student_id, assignment_id: chemAssignments[idx].id, raw_score, status, ...extra
      });
      await storage.table('gradebook_grades').bulkPut([
        grade(student1, 0, 92), grade(student1, 1, 47), grade(student1, 2, 19), grade(student1, 3, 36),
        grade(student2, 0, 78), grade(student2, 1, 41, 'late', { days_late: 1 }), grade(student2, 2, 0, 'missing'), grade(student2, 3, 31),
        grade(student3, 0, 85), grade(student3, 1, 44), grade(student3, 2, 17), grade(student3, 3, null, 'exempt')
      ]);

      // 3. Seed Flashcard Decks
      const flashcardsTable = storage.table('flashcards');
      const chemDeck = {
        version: 1,
        id: generateUUID(),
        class_id: apChem.id,
        title: 'Equilibrium & Reaction Kinetics',
        description: 'Key chemical equilibrium principles, Le Chatelier shifts, and rate laws.',
        updated_at: new Date().toISOString(),
        cards: [
          {
            id: generateUUID(),
            type: 'text',
            front: { text: 'What is the Henderson-Hasselbalch equation for buffer pH?', ttsLang: 'en-US' },
            back: { text: '$$pH = pK_a + \\log\\left(\\frac{[A^-]}{[HA]}\\right)$$\nRelates solution pH to acid dissociation constant $K_a$.', ttsLang: 'en-US' },
            fsrs: { state: 0, due: new Date().toISOString(), stability: 0, difficulty: 0, reps: 0, lapses: 0 }
          },
          {
            id: generateUUID(),
            type: 'text',
            front: { text: 'What is the balanced equation for the Haber-Bosch ammonia synthesis?', ttsLang: 'en-US' },
            back: { text: '$$\\ce{N2(g) + 3H2(g) <=> 2NH3(g)} \\quad \\Delta H < 0$$\nExothermic equilibrium reaction.', ttsLang: 'en-US' },
            fsrs: { state: 0, due: new Date().toISOString(), stability: 0, difficulty: 0, reps: 0, lapses: 0 }
          }
        ]
      };
      await flashcardsTable.put(chemDeck);

      // 4. Seed Timeline
      const timelinesTable = storage.table('timelines');
      const histTimeline = {
        version: 1,
        id: generateUUID(),
        class_id: worldHistory.id,
        title: 'Ancient & Classical Revolutions',
        description: 'From the Bronze Age collapse to the Roman Empire and Renaissance.',
        updated_at: new Date().toISOString(),
        events: [
          {
            id: generateUUID(),
            title: 'Assassination of Julius Caesar',
            start_date: '-0044-03-15',
            category: 'Politics',
            description: 'Ides of March marking the transition from Roman Republic to Empire.',
            color: '#dc2626'
          },
          {
            id: generateUUID(),
            title: 'Pax Romana Era',
            start_date: '-0027-01-16',
            end_date: '0180-03-17',
            category: 'Empire',
            description: 'Two centuries of relative peace throughout the Mediterranean Roman realm.',
            color: '#2563eb'
          },
          {
            id: generateUUID(),
            title: 'Martin Luther 95 Theses',
            start_date: '1517-10-31',
            category: 'Reformation',
            description: 'Disputation on the Power of Indulgences sparking the Protestant Reformation.',
            color: '#d97706'
          }
        ]
      };
      await timelinesTable.put(histTimeline);

      // 5. Seed Video Assessment
      const videoTable = storage.table('video_assessments');
      const chemVideo = {
        version: 1,
        id: generateUUID(),
        class_id: apChem.id,
        title: 'Entropy & Spontaneous Reactions',
        description: 'CrashCourse Chemistry #20 with checkpoints on entropy, the second law, and Gibbs free energy.',
        provider: 'youtube',
        video_source: 'https://www.youtube.com/watch?v=ZsY4WcQOrfk',
        updated_at: new Date().toISOString(),
        checkpoints: [
          {
            id: generateUUID(),
            timestamp_sec: 60,
            type: 'single_choice',
            prompt_markdown: 'Entropy ($S$) is best described as a measure of…',
            points: 1,
            options: [
              { id: 'opt-1', text: 'How many ways energy and particles can be arranged (dispersal)', is_correct: true, rationale: 'Entropy measures how spread out energy is across possible microstates.' },
              { id: 'opt-2', text: 'The total heat content of a system', is_correct: false, rationale: 'That describes enthalpy ($H$), not entropy.' },
              { id: 'opt-3', text: 'How fast a reaction proceeds', is_correct: false, rationale: 'Reaction rate is kinetics, not thermodynamics.' }
            ]
          },
          {
            id: generateUUID(),
            timestamp_sec: 180,
            type: 'single_choice',
            prompt_markdown: 'What does a negative Gibbs free energy change ($\\Delta G < 0$) indicate?',
            points: 2,
            options: [
              { id: 'opt-1', text: 'The reaction is thermodynamically spontaneous', is_correct: true, rationale: 'Negative ΔG means the process can proceed without outside work.' },
              { id: 'opt-2', text: 'The reaction is strictly endothermic', is_correct: false, rationale: 'ΔH can be positive if TΔS is large enough.' }
            ]
          },
          {
            id: generateUUID(),
            timestamp_sec: 300,
            type: 'open_response',
            prompt_markdown: 'Using $\\Delta G = \\Delta H - T\\Delta S$, explain why ice melts above 0 °C even though melting absorbs heat.',
            keywords: ['entropy', 'temperature', 'TΔS', 'positive', 'spontaneous', 'disorder', 'greater', 'larger'],
            points: 2
          }
        ]
      };
      await videoTable.put(chemVideo);

      toast.success('Interactive Demo Workspace loaded! Refreshing home view...');
      await renderHomeView(params, r, container);
    } catch (err) {
      console.error('Failed to seed demo data:', err);
      toast.danger('Could not seed demo workspace: ' + err.message);
    } finally {
      seedBtn?.removeAttribute('loading');
    }
  };

  container.querySelector('#btn-seed-demo-workspace')?.addEventListener('click', seedDemoWorkspace);
  container.querySelector('#btn-seed-empty-recent')?.addEventListener('click', seedDemoWorkspace);
}

export default renderHomeView;
