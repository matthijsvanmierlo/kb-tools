import { storage } from '../../core/storage.js';
import { SAMPLE_VIDEOS, DEFAULT_SAMPLE_VIDEO, RETIRED_SOURCES, getSampleVideo, detectVideoProvider } from './sample-videos.js';
import { store } from '../../state/store.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { createVideoDriver } from './drivers.js';
import { VideoGatekeeper } from './interceptor.js';
import { KioskReportEngine } from './kiosk-report.js';
import { SubmissionCrypto } from '../../core/submission-crypto.js';
import { normalizeAccessCode } from '../../core/access-codes.js';
import { buildStudentVideoPayload, createSecureReceipt, openReceipt, maxScoreOf, IDENTITY_LABELS } from './secure.js';
import { openVideoShareDialog, rosterChecksFor } from './share-video.js';
import { ProjectLibraryView } from '../../components/project-library.js';
import { ClassManager } from '../../components/class-manager.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { RichTextEditor } from '../../components/rich-text-editor.js';
import { replication } from '../../core/replication/manager.js';
import { syncContentClassLink } from '../gradebook/bridge.js';
import { StudentLedger } from '../student/ledger.js';

/**
 * Format seconds into mm:ss or mm:ss.s
 */
function formatSeconds(sec, showDecimal = false) {
  if (sec == null || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = showDecimal ? (sec % 60).toFixed(1) : Math.floor(sec % 60);
  const sStr = showDecimal ? (sec % 60 < 10 ? `0${s}` : `${s}`) : (s < 10 ? `0${s}` : `${s}`);
  return `${m}:${sStr}`;
}

/**
 * Parse mm:ss or decimal seconds into numeric seconds
 */
function parseSeconds(val) {
  if (typeof val === 'number') return val;
  const str = String(val).trim();
  if (str.includes(':')) {
    const parts = str.split(':');
    const m = parseFloat(parts[0]) || 0;
    const s = parseFloat(parts[1]) || 0;
    return m * 60 + s;
  }
  return parseFloat(str) || 0;
}

/**
 * Seed initial sample video assessment if store is empty, and repair demo
 * assessments that still point at video sources that no longer exist.
 */
async function ensureSampleVideoAssessment() {
  const table = storage.table('video_assessments');
  const existing = await table.toArray();

  for (const item of existing) {
    const replacement = RETIRED_SOURCES[item.video_source];
    if (replacement) {
      item.video_source = replacement.source;
      item.provider = replacement.provider;
      item.updated_at = new Date().toISOString();
      await table.put(item);
    }
  }

  if (existing.length === 0) {
    const sample = {
      version: 1,
      id: generateUUID(),
      title: 'Where Is the Edge of the Solar System?',
      description: 'NASA short film with checkpoints on the planets, the heliosphere, and the Oort Cloud.',
      class_id: null,
      provider: DEFAULT_SAMPLE_VIDEO.provider,
      video_source: DEFAULT_SAMPLE_VIDEO.source,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Timestamps follow the narration of the NASA video (see sample-videos.js)
      checkpoints: [
        {
          id: generateUUID(),
          timestamp_sec: 12.5,
          type: 'note',
          prompt_markdown: '### Watch closely\nThe narrator gives **three different ways** to decide where the solar system ends. Keep track of each one.',
          points: 0
        },
        {
          id: generateUUID(),
          timestamp_sec: 21.0,
          type: 'single_choice',
          prompt_markdown: 'If the solar system ends **where the planets end**, which planet marks that edge?',
          options: [
            { id: 'opt-1a', text: 'Neptune', is_correct: true, rationale: 'Neptune is the outermost planet; just beyond it lies the Kuiper Belt.' },
            { id: 'opt-1b', text: 'Pluto', is_correct: false, rationale: 'Pluto is classified as a dwarf planet inside the Kuiper Belt.' },
            { id: 'opt-1c', text: 'Uranus', is_correct: false, rationale: 'Uranus is the seventh planet; Neptune orbits farther out.' },
            { id: 'opt-1d', text: 'Saturn', is_correct: false, rationale: 'Saturn is the sixth planet from the Sun.' }
          ],
          points: 1
        },
        {
          id: generateUUID(),
          timestamp_sec: 29.5,
          type: 'single_choice',
          prompt_markdown: 'The Sun\'s magnetism reaches far beyond the planets. What is the bubble shaped by the Sun\'s magnetic field and solar wind called?',
          options: [
            { id: 'opt-2a', text: 'The heliosphere', is_correct: true, rationale: 'The heliosphere is the region dominated by the solar wind and the Sun\'s magnetic field.' },
            { id: 'opt-2b', text: 'The magnetosphere', is_correct: false, rationale: 'A magnetosphere surrounds a planet such as Earth, not the whole solar system.' },
            { id: 'opt-2c', text: 'The asteroid belt', is_correct: false, rationale: 'The asteroid belt lies between Mars and Jupiter.' }
          ],
          points: 1
        },
        {
          id: generateUUID(),
          timestamp_sec: 34.0,
          type: 'multi_choice',
          prompt_markdown: 'Which of these could reasonably be called the **edge of the solar system**? *(Select all that apply)*',
          options: [
            { id: 'opt-3a', text: 'Neptune and the Kuiper Belt', is_correct: true, rationale: 'Where the planets end.' },
            { id: 'opt-3b', text: 'The edge of the heliosphere', is_correct: true, rationale: 'Where the Sun\'s magnetic influence ends.' },
            { id: 'opt-3c', text: 'The Oort Cloud', is_correct: true, rationale: 'Where the Sun\'s gravitational influence ends.' },
            { id: 'opt-3d', text: 'The orbit of the Moon', is_correct: false, rationale: 'The Moon orbits Earth, deep inside the solar system.' }
          ],
          points: 2
        },
        {
          id: generateUUID(),
          timestamp_sec: 42.0,
          type: 'open_response',
          prompt_markdown: 'In your own words: why is there **no single answer** to where the solar system ends?',
          keywords: ['depends', 'definition', 'criteria', 'planets', 'magnetic', 'magnetism', 'gravity', 'heliosphere', 'oort', 'kuiper'],
          points: 2
        }
      ]
    };
    await table.put(sample);
    return sample;
  }
  return null;
}

/**
 * Video Assessment Module Controller (Library, Editor & Kiosk Modes)
 */
export async function renderVideoView(params, router, container) {
  await ensureSampleVideoAssessment();

  const hash = window.location.hash || '#/video';
  const isKiosk = params.kiosk === '1' || hash.startsWith('#/video/kiosk');
  const isEdit = hash.startsWith('#/video/edit');

  let activeVideo = store.getState('activeVideo');
  const videoId = params.id;

  if (videoId) {
    activeVideo = await storage.table('video_assessments').get(videoId);
    if (activeVideo) store.setState('activeVideo', activeVideo);
  }

  // 1. Student Kiosk Mode
  if (isKiosk) {
    if (!activeVideo) {
      const videos = await storage.table('video_assessments').toArray();
      if (videos.length > 0) activeVideo = videos[0];
    }
    if (!activeVideo) {
      toast.warning('No video assessment found for Kiosk mode.');
      router.navigate('#/video');
      return;
    }
    // Kiosk always runs from the student-safe payload; build one locally when launched on this device
    let kioskPayload = activeVideo;
    if (!activeVideo.secure) {
      const teacherKeys = await replication.publishKeysFor(activeVideo.class_id);
      const { checks } = await rosterChecksFor(activeVideo);
      kioskPayload = await buildStudentVideoPayload(activeVideo, { teacherKeys, rosterChecks: checks, instantFeedback: true });
      kioskPayload.secure.local = true;
    }
    return renderStudentKioskMode(kioskPayload, container, router);
  }

  // 2. Teacher Editor Mode
  if (isEdit) {
    if (!activeVideo) {
      if (videoId) {
        toast.warning('Assessment not found.');
        router.navigate('#/video');
        return;
      }
      // Create new blank assessment (default to Formative Practice)
      activeVideo = {
        version: 1,
        id: generateUUID(),
        title: 'New Video Assessment',
        description: '',
        class_id: null,
        settings: {
          release_grade_immediately: true,
          feedback_mode: 'instant',
          show_correct_answers: true
        },
        provider: DEFAULT_SAMPLE_VIDEO.provider,
        video_source: DEFAULT_SAMPLE_VIDEO.source,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        checkpoints: []
      };
      await storage.table('video_assessments').put(activeVideo);
      store.setState('activeVideo', activeVideo);
    }
    return renderTeacherEditorMode(activeVideo, container, router);
  }

  // 3. Default: Video Assessment Library Grid
  return renderVideoLibrary(container, router);
}

/**
 * Render Video Assessments Library
 */
async function renderVideoLibrary(container, router) {
  const library = new ProjectLibraryView({
    moduleType: 'video',
    title: 'Video Assessments',
    itemTypeName: 'Assessment',
    tableName: 'video_assessments',
    createRoute: '#/video/edit',
    openLabel: 'Launch Kiosk',
    editLabel: 'Edit Assessment',
    accentColor: '#e11d48',
    iconName: 'play-circle',
    // Never share the full record: it contains the answer key
    onShare: (item) => openVideoShareDialog(item),
    getOpenUrl: (item) => `#/video/kiosk?id=${item.id}`,
    getEditUrl: (item) => `#/video/edit?id=${item.id}`,
    getMetadataSummary: (item) => {
      const cpCount = item.checkpoints?.length || 0;
      const provider = (item.provider || 'video').toUpperCase();
      return `${cpCount} checkpoint${cpCount === 1 ? '' : 's'} • ${provider}`;
    },
    onDuplicate: async (item) => {
      const cloned = {
        ...item,
        id: generateUUID(),
        title: `${item.title || 'Assessment'} (Copy)`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        checkpoints: (item.checkpoints || []).map(cp => ({ ...cp, id: generateUUID() }))
      };
      await storage.table('video_assessments').put(cloned);
      toast.success('Assessment duplicated!');
      return cloned;
    }
  });

  await library.render(container);

  // Add "Verify .kbr Receipt" button to the header
  const headerActions = container.querySelector('.flex.items-center.gap-2.flex-wrap');
  if (headerActions) {
    const verifyBtn = document.createElement('sl-button');
    verifyBtn.size = 'small';
    verifyBtn.variant = 'default';
    verifyBtn.innerHTML = '<sl-icon slot="prefix" name="shield-check"></sl-icon> Verify .kbr Receipt';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.kbr';
    fileInput.className = 'hidden';

    verifyBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const content = await file.text();
        showReceiptResultDialog(await openReceiptOnThisDevice(content));
      } catch (err) {
        console.error('Verify error:', err);
        toast.danger('Invalid or unreadable .kbr receipt file.');
      } finally {
        fileInput.value = '';
      }
    });

    headerActions.prepend(verifyBtn);
    container.appendChild(fileInput);
  }
}

/**
 * Render Teacher Editor Mode
 */
async function renderTeacherEditorMode(activeVideo, container, router) {
  const classes = await ClassManager.getClasses();
  let driver = null;
  let isPlaying = false;
  let duration = 0;
  let currentTime = 0;
  let pollInterval = null;

  const safeTitle = Sanitizer.escapeHTML(activeVideo.title || 'Untitled Assessment');

  container.innerHTML = `
    <div class="space-y-4 max-w-7xl mx-auto">
      <!-- Top Navigation & Action Dock -->
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
        <div class="flex items-center gap-3">
          <sl-button size="small" id="btn-back-library" variant="default">
            <sl-icon slot="prefix" name="arrow-left"></sl-icon> Library
          </sl-button>
          <div>
            <h2 class="font-bold text-slate-900 text-lg flex items-center gap-2">
              <span id="title-display">${safeTitle}</span>
            </h2>
            <p class="text-xs text-slate-500" id="header-metadata-display">
              <span id="cp-count-badge">${activeVideo.checkpoints?.length || 0}</span> checkpoint(s) &bull; Provider: ${Sanitizer.escapeHTML((activeVideo.provider || 'html5').toUpperCase())}
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <sl-button size="small" id="btn-launch-kiosk" variant="primary">
            <sl-icon slot="prefix" name="play-circle"></sl-icon> Test Kiosk View
          </sl-button>
          <sl-button size="small" id="btn-share-video" variant="default">
            <sl-icon slot="prefix" name="share"></sl-icon> Share Lesson...
          </sl-button>
          <sl-button size="small" id="btn-verify-receipt" variant="default">
            <sl-icon slot="prefix" name="shield-check"></sl-icon> Check .kbr receipt
          </sl-button>
          <input type="file" id="input-kbr-verify" accept=".kbr" class="hidden" />
        </div>
      </div>

      <!-- Video Project Settings Panel -->
      <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
        <div class="text-xs font-semibold text-slate-700 uppercase tracking-wider flex items-center justify-between">
          <span>Assessment Settings</span>
          <span class="text-slate-400 font-normal">Changes auto-save</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <div class="md:col-span-8">
            <sl-input id="input-video-title" label="Assessment title" value="${safeTitle}"></sl-input>
          </div>
          <div class="md:col-span-4">
            <sl-select id="select-video-class" label="Class (Graded vs Formative)" value="${Sanitizer.escapeHTML(activeVideo.class_id || '')}">
              <sl-option value="">Formative Practice (Ungraded)</sl-option>
              ${classes.map(c => `<sl-option value="${c.id}">Graded · ${Sanitizer.escapeHTML(c.name)}</sl-option>`).join('')}
            </sl-select>
          </div>
          <div class="md:col-span-3">
            <sl-select id="select-video-provider" label="Video provider" value="${Sanitizer.escapeHTML(activeVideo.provider || 'html5')}">
              <sl-option value="html5"><sl-icon slot="prefix" name="film"></sl-icon> MP4 / WebM file</sl-option>
              <sl-option value="youtube"><sl-icon slot="prefix" name="youtube"></sl-icon> YouTube</sl-option>
              <sl-option value="vimeo"><sl-icon slot="prefix" name="vimeo"></sl-icon> Vimeo</sl-option>
            </sl-select>
          </div>
          <div class="md:col-span-5">
            <sl-input id="input-video-source" label="Video URL or ID" placeholder="Paste a YouTube, Vimeo, or .mp4 link (provider auto-detected)" value="${Sanitizer.escapeHTML(activeVideo.video_source || '')}">
              <sl-icon slot="prefix" name="link-45deg"></sl-icon>
            </sl-input>
          </div>
          <div class="md:col-span-4 flex items-center justify-between pb-1 gap-2">
            <sl-switch id="switch-video-release-grade" ${activeVideo.settings?.release_grade_immediately !== false ? 'checked' : ''} class="text-xs">
              <span class="text-xs font-medium text-slate-700">Release score immediately</span>
            </sl-switch>
          </div>
          <div class="md:col-span-3 flex items-end gap-2">
            <sl-dropdown id="dropdown-sample-videos" placement="bottom-end" class="flex-1" hoist>
              <sl-button slot="trigger" caret class="w-full">
                <sl-icon slot="prefix" name="collection-play"></sl-icon> Samples
              </sl-button>
              <sl-menu id="menu-sample-videos">
                <sl-menu-label>Verified demo videos</sl-menu-label>
                ${SAMPLE_VIDEOS.map(v => `
                  <sl-menu-item value="${v.key}">
                    <sl-icon slot="prefix" name="${v.provider === 'youtube' ? 'youtube' : v.provider === 'vimeo' ? 'vimeo' : 'film'}"></sl-icon>
                    ${Sanitizer.escapeHTML(v.label)}
                    <div class="text-[11px] text-slate-400">${Sanitizer.escapeHTML(v.subject)} · ${Sanitizer.escapeHTML(v.credit)}</div>
                  </sl-menu-item>
                `).join('')}
              </sl-menu>
            </sl-dropdown>
            <sl-tooltip content="Reload preview">
              <sl-button id="btn-reload-video" variant="default" aria-label="Reload video preview">
                <sl-icon name="arrow-clockwise"></sl-icon>
              </sl-button>
            </sl-tooltip>
          </div>
        </div>
      </div>

      <!-- Main Workspace: Video Player + Checkpoint Editor -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <!-- Video Player Column (7 cols) -->
        <div class="lg:col-span-7 bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
          <div class="relative bg-black rounded-xl overflow-hidden aspect-video flex items-center justify-center">
            <div id="editor-video-mount" class="w-full h-full"></div>
          </div>

          <!-- Video Controls & Custom Scrubber with Checkpoint Markers -->
          <div class="space-y-2">
            <div class="relative flex items-center h-8 px-1">
              <input type="range" id="editor-scrubber" min="0" max="100" value="0" class="w-full cursor-pointer z-10" />
              <div id="editor-scrubber-markers" class="absolute inset-x-2 top-1/2 -translate-y-1/2 pointer-events-none h-3"></div>
            </div>

            <div class="flex items-center justify-between text-xs text-slate-600">
              <div class="flex items-center gap-2">
                <sl-button size="small" id="btn-editor-play">
                  <sl-icon id="icon-editor-play" name="play-fill"></sl-icon>
                </sl-button>
                <span id="editor-time-display" class="font-mono">0:00 / 0:00</span>
              </div>
              <sl-button size="small" variant="primary" id="btn-add-checkpoint-now">
                <sl-icon slot="prefix" name="plus-circle"></sl-icon> Add Checkpoint Here
              </sl-button>
            </div>
          </div>
        </div>

        <!-- Checkpoints List Column (5 cols) -->
        <div class="lg:col-span-5 bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between pb-2 border-b">
              <h3 class="font-bold text-slate-800 text-sm">Checkpoints Timeline</h3>
              <span class="text-xs text-slate-400 font-mono" id="timeline-count-badge">${activeVideo.checkpoints?.length || 0} items</span>
            </div>
            <div class="space-y-2 py-3 overflow-y-auto max-h-[480px]" id="checkpoints-list-container">
              <!-- Rendered dynamically -->
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Mount Video Driver
  const videoMount = container.querySelector('#editor-video-mount');
  const scrubber = container.querySelector('#editor-scrubber');
  const scrubberMarkers = container.querySelector('#editor-scrubber-markers');
  const playBtn = container.querySelector('#btn-editor-play');
  const playIcon = container.querySelector('#icon-editor-play');
  const timeDisplay = container.querySelector('#editor-time-display');
  const checkpointsList = container.querySelector('#checkpoints-list-container');

  async function initDriver() {
    if (driver) {
      try { driver.destroy(); } catch (_) {}
    }
    // Reset playback state so the previous video's duration/markers don't linger
    duration = 0;
    currentTime = 0;
    if (timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
    if (scrubber) scrubber.value = 0;
    driver = createVideoDriver(activeVideo.provider || 'html5');
    await driver.mount(videoMount, activeVideo.video_source);
    isPlaying = false;
    updatePlayButton();
  }

  await initDriver();

  function updatePlayButton() {
    if (playIcon) playIcon.name = isPlaying ? 'pause-fill' : 'play-fill';
  }

  playBtn?.addEventListener('click', async () => {
    if (!driver) return;
    if (isPlaying) {
      await driver.pause();
      isPlaying = false;
    } else {
      await driver.play();
      isPlaying = true;
    }
    updatePlayButton();
  });

  // Scrubber user scrub
  scrubber?.addEventListener('input', async () => {
    if (!driver || duration <= 0) return;
    const target = (scrubber.value / 100) * duration;
    await driver.seekTo(target);
  });

  // Render Checkpoints List & Markers
  function renderCheckpointsUI() {
    if (!activeVideo.checkpoints) activeVideo.checkpoints = [];
    activeVideo.checkpoints.sort((a, b) => a.timestamp_sec - b.timestamp_sec);

    // Update list
    if (activeVideo.checkpoints.length === 0) {
      checkpointsList.innerHTML = `
        <div class="text-center py-8 text-slate-400 text-xs">
          <sl-icon name="stopwatch" class="text-2xl mb-1 text-slate-300"></sl-icon>
          <p>No checkpoints yet.</p>
          <p class="mt-0.5">Play the video and click <strong>"Add Checkpoint Here"</strong>.</p>
        </div>
      `;
    } else {
      checkpointsList.innerHTML = activeVideo.checkpoints.map((cp, idx) => {
        const typeLabels = {
          single_choice: { label: 'Single Choice', color: 'bg-blue-100 text-blue-700' },
          multi_choice: { label: 'Multi Select', color: 'bg-violet-100 text-violet-700' },
          open_response: { label: 'Open Answer', color: 'bg-amber-100 text-amber-700' },
          note: { label: 'Video Note', color: 'bg-emerald-100 text-emerald-700' }
        };
        const badge = typeLabels[cp.type] || { label: cp.type, color: 'bg-slate-100 text-slate-700' };
        // Compact preview: render math/markdown but flatten headings so rows stay one size
        const previewHtml = Sanitizer.renderSTEMMarkdown((cp.prompt_markdown || '').replace(/^#{1,6}\s*/gm, ''));
        const timeFormatted = formatSeconds(cp.timestamp_sec, true);

        return `
          <div class="group p-3 border border-slate-200 rounded-xl bg-white hover:border-slate-300 hover:shadow-sm transition-all flex items-start justify-between gap-3 text-xs" data-cp-id="${Sanitizer.escapeHTML(cp.id)}">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <button type="button" class="btn-seek-cp inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-100 hover:bg-blue-50 font-semibold text-blue-700 tabular-nums cursor-pointer" data-sec="${Sanitizer.safeNumber(cp.timestamp_sec)}" title="Jump to ${timeFormatted}">
                  <sl-icon name="play-fill" class="text-[10px]"></sl-icon>${timeFormatted}
                </button>
                <span class="px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide ${badge.color}">${Sanitizer.escapeHTML(badge.label)}</span>
                <span class="text-slate-400 text-[11px] tabular-nums">${Sanitizer.safeNumber(cp.points)} pt${cp.points === 1 ? '' : 's'}</span>
              </div>
              <div class="kb-prose text-slate-700 mt-1.5 line-clamp-2 [&_p]:m-0">${previewHtml}</div>
            </div>
            <div class="flex items-center flex-shrink-0 -mr-1">
              <button type="button" class="btn-edit-cp kb-icon-btn !w-8 !h-8 hover:!text-blue-600" title="Edit checkpoint" aria-label="Edit checkpoint" data-id="${Sanitizer.escapeHTML(cp.id)}">
                <sl-icon name="pencil"></sl-icon>
              </button>
              <button type="button" class="btn-duplicate-cp kb-icon-btn !w-8 !h-8" title="Duplicate checkpoint" aria-label="Duplicate checkpoint" data-id="${Sanitizer.escapeHTML(cp.id)}">
                <sl-icon name="copy"></sl-icon>
              </button>
              <button type="button" class="btn-del-cp kb-icon-btn !w-8 !h-8 hover:!text-red-600" title="Delete checkpoint" aria-label="Delete checkpoint" data-id="${Sanitizer.escapeHTML(cp.id)}">
                <sl-icon name="trash"></sl-icon>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    // Bind item buttons
    checkpointsList.querySelectorAll('.btn-seek-cp').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sec = parseFloat(btn.getAttribute('data-sec'));
        if (driver) await driver.seekTo(sec);
      });
    });

    checkpointsList.querySelectorAll('.btn-edit-cp').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const cp = activeVideo.checkpoints.find(c => c.id === id);
        if (cp) {
          openCheckpointAuthoringModal({
            activeVideo,
            checkpoint: cp,
            currentVideoTime: currentTime,
            onSave: async () => {
              await saveAssessment();
              renderCheckpointsUI();
              renderMarkersUI();
            }
          });
        }
      });
    });

    checkpointsList.querySelectorAll('.btn-duplicate-cp').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const cp = activeVideo.checkpoints.find(c => c.id === id);
        if (cp) {
          const clone = JSON.parse(JSON.stringify(cp));
          clone.id = generateUUID();
          clone.timestamp_sec = Math.min(duration || 9999, clone.timestamp_sec + 2.0);
          clone.prompt_markdown = `${clone.prompt_markdown} (Copy)`;
          activeVideo.checkpoints.push(clone);
          await saveAssessment();
          renderCheckpointsUI();
          renderMarkersUI();
          toast.success('Checkpoint duplicated!');
        }
      });
    });

    checkpointsList.querySelectorAll('.btn-del-cp').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const confirmed = await ConfirmDialog.show({
          title: 'Delete Checkpoint',
          message: 'Are you sure you want to remove this checkpoint?',
          confirmText: 'Delete',
          variant: 'danger'
        });
        if (confirmed) {
          activeVideo.checkpoints = activeVideo.checkpoints.filter(c => c.id !== id);
          await saveAssessment();
          renderCheckpointsUI();
          renderMarkersUI();
          toast.info('Checkpoint removed.');
        }
      });
    });

    // Update count badges
    const countBadge = container.querySelector('#cp-count-badge');
    const timeCountBadge = container.querySelector('#timeline-count-badge');
    if (countBadge) countBadge.textContent = activeVideo.checkpoints.length;
    if (timeCountBadge) timeCountBadge.textContent = `${activeVideo.checkpoints.length} items`;
  }

  function renderMarkersUI() {
    if (!scrubberMarkers || duration <= 0) return;
    scrubberMarkers.innerHTML = (activeVideo.checkpoints || []).map(cp => {
      const pct = Math.min(100, Math.max(0, (cp.timestamp_sec / duration) * 100));
      const safePrompt = Sanitizer.escapeHTML((cp.prompt_markdown || '').slice(0, 45));
      return `
        <div class="absolute w-2.5 h-2.5 -ml-1.25 rounded-full bg-blue-600 border border-white shadow-xs pointer-events-auto cursor-pointer hover:scale-125 transition-transform"
             style="left: ${pct}%; top: 50%; transform: translateY(-50%);"
             title="@${formatSeconds(cp.timestamp_sec, true)}: ${safePrompt}"
             data-sec="${Sanitizer.safeNumber(cp.timestamp_sec)}">
        </div>
      `;
    }).join('');

    scrubberMarkers.querySelectorAll('[data-sec]').forEach(marker => {
      marker.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sec = parseFloat(marker.getAttribute('data-sec'));
        if (driver) await driver.seekTo(sec);
      });
    });
  }

  renderCheckpointsUI();

  // Time polling loop
  pollInterval = setInterval(async () => {
    if (!driver) return;
    try {
      currentTime = await driver.getCurrentTime();
      const dur = await driver.getDuration();
      if (dur > 0 && dur !== duration) {
        duration = dur;
        renderMarkersUI();
      }
      if (timeDisplay) {
        timeDisplay.textContent = `${formatSeconds(currentTime)} / ${formatSeconds(duration)}`;
      }
      if (scrubber && duration > 0 && !scrubber.matches(':active')) {
        scrubber.value = (currentTime / duration) * 100;
      }
    } catch (_) {}
  }, 250);

  // Auto-save helper
  async function saveAssessment() {
    activeVideo.updated_at = new Date().toISOString();
    await storage.table('video_assessments').put(activeVideo);
  }

  // Bind Settings inputs
  const titleInput = container.querySelector('#input-video-title');
  const classSelect = container.querySelector('#select-video-class');
  const providerSelect = container.querySelector('#select-video-provider');
  const sourceInput = container.querySelector('#input-video-source');
  const reloadBtn = container.querySelector('#btn-reload-video');

  titleInput?.addEventListener('sl-input', () => {
    activeVideo.title = titleInput.value.trim() || 'Untitled Assessment';
    const display = container.querySelector('#title-display');
    if (display) display.textContent = activeVideo.title;
    saveAssessment();
  });

  classSelect?.addEventListener('sl-change', async () => {
    const classId = classSelect.value || null;
    await syncContentClassLink(activeVideo, 'video', classId);
    toast.info(classId ? 'Linked to class Gradebook column.' : 'Set to Formative Practice (ungraded).');
  });

  const releaseGradeSwitch = container.querySelector('#switch-video-release-grade');
  releaseGradeSwitch?.addEventListener('sl-change', () => {
    if (!activeVideo.settings) activeVideo.settings = {};
    activeVideo.settings.release_grade_immediately = releaseGradeSwitch.checked;
    saveAssessment();
  });

  providerSelect?.addEventListener('sl-change', () => {
    activeVideo.provider = providerSelect.value;
    const headerMetadata = container.querySelector('#header-metadata-display');
    if (headerMetadata) {
      headerMetadata.innerHTML = `${activeVideo.checkpoints?.length || 0} checkpoint(s) &bull; Provider: ${Sanitizer.escapeHTML((activeVideo.provider || 'html5').toUpperCase())}`;
    }
    saveAssessment();
  });

  const updateHeaderMetadata = () => {
    const headerMetadata = container.querySelector('#header-metadata-display');
    if (headerMetadata) {
      headerMetadata.innerHTML = `${activeVideo.checkpoints?.length || 0} checkpoint(s) &bull; Provider: ${Sanitizer.escapeHTML((activeVideo.provider || 'html5').toUpperCase())}`;
    }
  };

  sourceInput?.addEventListener('sl-input', () => {
    activeVideo.video_source = sourceInput.value.trim();
    const detected = detectVideoProvider(activeVideo.video_source);
    if (detected && detected !== providerSelect.value) {
      providerSelect.value = detected;
      activeVideo.provider = detected;
      updateHeaderMetadata();
    }
    saveAssessment();
  });

  // Reload the preview once a pasted link is committed
  sourceInput?.addEventListener('sl-change', async () => {
    await initDriver();
  });

  container.querySelector('#menu-sample-videos')?.addEventListener('sl-select', async (e) => {
    const sample = getSampleVideo(e.detail.item.value);
    if (!sample) return;
    activeVideo.video_source = sample.source;
    activeVideo.provider = sample.provider;
    sourceInput.value = sample.source;
    providerSelect.value = sample.provider;
    updateHeaderMetadata();
    await saveAssessment();
    await initDriver();
    toast.success(`Loaded sample: ${sample.label}`);
  });

  reloadBtn?.addEventListener('click', async () => {
    activeVideo.video_source = sourceInput.value.trim();
    activeVideo.provider = providerSelect.value;
    await saveAssessment();
    toast.info('Reloading video player...');
    await initDriver();
  });

  // Add Checkpoint Now
  container.querySelector('#btn-add-checkpoint-now')?.addEventListener('click', async () => {
    if (driver && isPlaying) {
      await driver.pause();
      isPlaying = false;
      updatePlayButton();
    }
    openCheckpointAuthoringModal({
      activeVideo,
      currentVideoTime: currentTime,
      onSave: async () => {
        await saveAssessment();
        renderCheckpointsUI();
        renderMarkersUI();
        toast.success('Checkpoint added!');
      }
    });
  });

  // Back to Library
  container.querySelector('#btn-back-library')?.addEventListener('click', () => {
    router.navigate('#/video');
  });

  // Launch Kiosk
  container.querySelector('#btn-launch-kiosk')?.addEventListener('click', () => {
    store.setState('activeVideo', activeVideo);
    router.navigate(`#/video/kiosk?id=${activeVideo.id}`);
  });

  // Share Lesson
  container.querySelector('#btn-share-video')?.addEventListener('click', () => {
    openVideoShareDialog(activeVideo);
  });

  // Verify Receipt
  const kbrInput = container.querySelector('#input-kbr-verify');
  container.querySelector('#btn-verify-receipt')?.addEventListener('click', () => {
    kbrInput?.click();
  });

  kbrInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      showReceiptResultDialog(await openReceiptOnThisDevice(content));
    } catch (err) {
      console.error('Verify error:', err);
      toast.danger('Invalid or unreadable .kbr receipt file.');
    } finally {
      kbrInput.value = '';
    }
  });

  return () => {
    if (pollInterval) clearInterval(pollInterval);
    if (driver) {
      try { driver.destroy(); } catch (_) {}
    }
  };
}

/**
 * Full Checkpoint Authoring & Edit Modal (All 4 Question Types, STEM Math/Chem, Dynamic Options)
 */
function openCheckpointAuthoringModal({ activeVideo, checkpoint, currentVideoTime = 0, onSave }) {
  const isEditing = !!checkpoint;
  const initialData = isEditing ? JSON.parse(JSON.stringify(checkpoint)) : {
    id: generateUUID(),
    timestamp_sec: Number(currentVideoTime.toFixed(1)),
    type: 'single_choice',
    prompt_markdown: '',
    points: 1,
    options: [
      { id: generateUUID(), text: '', is_correct: true, rationale: '' },
      { id: generateUUID(), text: '', is_correct: false, rationale: '' }
    ],
    keywords: []
  };

  const dialog = document.createElement('sl-dialog');
  dialog.label = isEditing ? 'Edit Checkpoint' : 'Add New Checkpoint';
  dialog.style.setProperty('--width', '680px');

  dialog.innerHTML = `
    <div class="space-y-4">
      <!-- Timestamp & Points Header Row -->
      <div class="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
        <div class="sm:col-span-5">
          <sl-input id="input-cp-timestamp" label="Trigger Timestamp (sec or mm:ss)" value="${Sanitizer.escapeHTML(initialData.timestamp_sec)}" type="text" help-text="e.g. 15.5 or 0:15.5"></sl-input>
        </div>
        <div class="sm:col-span-3">
          <sl-button size="small" id="btn-use-cur-time" class="w-full">
            <sl-icon slot="prefix" name="clock"></sl-icon> Current Time
          </sl-button>
        </div>
        <div class="sm:col-span-4">
          <sl-input id="input-cp-points" label="Points Value (0-100)" type="number" min="0" max="100" value="${Sanitizer.safeNumber(initialData.points, 1)}"></sl-input>
        </div>
      </div>

      <!-- Question Type Selector -->
      <div>
        <sl-select id="select-cp-type" label="Question Type" value="${Sanitizer.escapeHTML(initialData.type || 'single_choice')}">
          <sl-option value="single_choice">Multiple Choice (Single Answer)</sl-option>
          <sl-option value="multi_choice">Multiple Select (Checkboxes)</sl-option>
          <sl-option value="open_response">Open / Short Answer (Auto-Grade Keywords)</sl-option>
          <sl-option value="note">Video Note / Rich STEM Callout</sl-option>
        </sl-select>
      </div>

      <!-- Rich STEM Prompt Editor Container -->
      <div>
        <label class="text-xs font-semibold text-slate-700 block mb-1">Question Prompt / Note Content (Markdown &amp; STEM KaTeX)</label>
        <div id="prompt-rte-container" class="border rounded-xl"></div>
      </div>

      <!-- Dynamic Options Builder (for single_choice & multi_choice) -->
      <div id="options-builder-container" class="space-y-2">
        <div class="flex items-center justify-between">
          <label class="text-xs font-semibold text-slate-700" id="options-header-label">Options &amp; Correct Answer:</label>
          <sl-button size="small" variant="default" id="btn-add-option">
            <sl-icon slot="prefix" name="plus"></sl-icon> Add Option
          </sl-button>
        </div>
        <div id="options-list-mount" class="space-y-2 max-h-60 overflow-y-auto pr-1"></div>
      </div>

      <!-- Auto-Grade Keywords Container (for open_response) -->
      <div id="keywords-builder-container" class="space-y-2 hidden">
        <sl-input id="input-keywords" label="Auto-Grade Accepted Keywords" placeholder="e.g. gas, giant, hydrogen, red spot" help-text="Comma-separated keywords. If the student's answer contains any of these, full points are awarded." value="${Sanitizer.escapeHTML((initialData.keywords || []).join(', '))}"></sl-input>
      </div>
    </div>

    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-modal">Cancel</sl-button>
      <sl-button variant="primary" id="btn-save-modal">Save Checkpoint</sl-button>
    </div>
  `;

  document.body.appendChild(dialog);
  dialog.show();

  // Mount RichTextEditor for Prompt
  const rteMount = dialog.querySelector('#prompt-rte-container');
  const promptRTE = new RichTextEditor({
    initialValue: initialData.prompt_markdown || '',
    placeholder: 'Enter question prompt, math formulas $E = mc^2$, or chemical equations $\\ce{H2O}$...',
    height: '140px'
  });
  promptRTE.mount(rteMount);

  // Dynamic Options State
  let options = initialData.options && initialData.options.length >= 2
    ? JSON.parse(JSON.stringify(initialData.options))
    : [
        { id: generateUUID(), text: '', is_correct: true, rationale: '' },
        { id: generateUUID(), text: '', is_correct: false, rationale: '' }
      ];

  const typeSelect = dialog.querySelector('#select-cp-type');
  const optionsContainer = dialog.querySelector('#options-builder-container');
  const keywordsContainer = dialog.querySelector('#keywords-builder-container');
  const optionsListMount = dialog.querySelector('#options-list-mount');
  const addOptionBtn = dialog.querySelector('#btn-add-option');

  function renderOptionsList() {
    const isMulti = typeSelect.value === 'multi_choice';
    const inputType = isMulti ? 'checkbox' : 'radio';

    optionsListMount.innerHTML = options.map((opt, idx) => `
      <div class="p-2.5 border rounded-lg bg-slate-50 space-y-1.5" data-opt-idx="${idx}">
        <div class="flex items-center gap-2">
          <input type="${inputType}" name="opt-correct-group" value="${idx}" ${opt.is_correct ? 'checked' : ''} class="w-4 h-4 cursor-pointer" title="Mark as correct answer" />
          <sl-input class="flex-1 opt-text-input" size="small" placeholder="Option ${idx + 1} text..." value="${Sanitizer.escapeHTML(opt.text || '')}"></sl-input>
          <button type="button" class="btn-remove-opt text-slate-400 hover:text-red-600 p-1 ${options.length <= 2 ? 'opacity-30 cursor-not-allowed' : ''}" title="Remove option" data-idx="${idx}">
            <sl-icon name="x-lg"></sl-icon>
          </button>
        </div>
        <sl-input class="opt-rationale-input text-xs" size="small" placeholder="Optional explanation/rationale shown after answering..." value="${Sanitizer.escapeHTML(opt.rationale || '')}"></sl-input>
      </div>
    `).join('');

    // Bind inputs & buttons
    optionsListMount.querySelectorAll('.opt-text-input').forEach((inp, idx) => {
      inp.addEventListener('sl-input', () => {
        options[idx].text = inp.value;
      });
    });

    optionsListMount.querySelectorAll('.opt-rationale-input').forEach((inp, idx) => {
      inp.addEventListener('sl-input', () => {
        options[idx].rationale = inp.value;
      });
    });

    optionsListMount.querySelectorAll('input[name="opt-correct-group"]').forEach(inp => {
      inp.addEventListener('change', () => {
        if (isMulti) {
          options.forEach((o, i) => {
            const check = optionsListMount.querySelector(`input[name="opt-correct-group"][value="${i}"]`);
            o.is_correct = check ? check.checked : false;
          });
        } else {
          const checkedIdx = parseInt(inp.value, 10);
          options.forEach((o, i) => {
            o.is_correct = (i === checkedIdx);
          });
        }
      });
    });

    optionsListMount.querySelectorAll('.btn-remove-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        if (options.length <= 2) return;
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        options.splice(idx, 1);
        renderOptionsList();
      });
    });

    if (addOptionBtn) {
      addOptionBtn.disabled = options.length >= 8;
    }
  }

  function updateTypeView() {
    const val = typeSelect.value;
    if (val === 'single_choice' || val === 'multi_choice') {
      optionsContainer.classList.remove('hidden');
      keywordsContainer.classList.add('hidden');
      renderOptionsList();
    } else if (val === 'open_response') {
      optionsContainer.classList.add('hidden');
      keywordsContainer.classList.remove('hidden');
    } else {
      // note
      optionsContainer.classList.add('hidden');
      keywordsContainer.classList.add('hidden');
    }
  }

  typeSelect.addEventListener('sl-change', updateTypeView);
  updateTypeView();

  addOptionBtn?.addEventListener('click', () => {
    if (options.length < 8) {
      options.push({ id: generateUUID(), text: '', is_correct: false, rationale: '' });
      renderOptionsList();
    }
  });

  dialog.querySelector('#btn-use-cur-time')?.addEventListener('click', () => {
    dialog.querySelector('#input-cp-timestamp').value = currentVideoTime.toFixed(1);
  });

  // Save Checkpoint
  dialog.querySelector('#btn-save-modal')?.addEventListener('click', () => {
    const timeRaw = dialog.querySelector('#input-cp-timestamp').value;
    const timestampSec = parseSeconds(timeRaw);
    const points = Math.max(0, parseInt(dialog.querySelector('#input-cp-points').value, 10) || 0);
    const type = typeSelect.value;
    const prompt = promptRTE.getValue().trim();

    if (!prompt) {
      toast.warning('Please enter a question prompt or note content.');
      return;
    }

    if (type === 'single_choice' || type === 'multi_choice') {
      const validOpts = options.filter(o => o.text && o.text.trim());
      if (validOpts.length < 2) {
        toast.warning('Please provide at least 2 options with text.');
        return;
      }
      const hasCorrect = options.some(o => o.is_correct && o.text && o.text.trim());
      if (!hasCorrect) {
        toast.warning('Please select at least one correct answer option.');
        return;
      }
    }

    let keywords = [];
    if (type === 'open_response') {
      const kwStr = dialog.querySelector('#input-keywords').value;
      keywords = kwStr.split(',').map(s => s.trim()).filter(Boolean);
    }

    const updated = {
      id: initialData.id,
      timestamp_sec: timestampSec,
      type,
      prompt_markdown: prompt,
      points: type === 'note' ? 0 : points,
      options: (type === 'single_choice' || type === 'multi_choice') ? options : undefined,
      keywords: type === 'open_response' ? keywords : undefined
    };

    if (isEditing) {
      const idx = activeVideo.checkpoints.findIndex(c => c.id === updated.id);
      if (idx !== -1) {
        activeVideo.checkpoints[idx] = updated;
      } else {
        activeVideo.checkpoints.push(updated);
      }
    } else {
      if (!activeVideo.checkpoints) activeVideo.checkpoints = [];
      activeVideo.checkpoints.push(updated);
    }

    activeVideo.checkpoints.sort((a, b) => a.timestamp_sec - b.timestamp_sec);
    dialog.remove();
    if (onSave) onSave();
  });

  dialog.querySelector('#btn-cancel-modal')?.addEventListener('click', () => dialog.remove());
}

/**
 * Render Student Kiosk Mode (Clean Start Card, Video Interceptor, Progress Bar with Markers)
 */
async function renderStudentKioskMode(assessment, container, router) {
  const safeTitle = Sanitizer.escapeHTML(assessment.title || 'Video Assessment');
  const checkpoints = assessment.checkpoints || [];
  const maxScore = maxScoreOf(checkpoints);
  const rosterChecks = assessment.secure?.roster_checks || null;
  const questionCount = checkpoints.filter(c => c.type !== 'note').length;

  let className = '';
  if (assessment.class_id) {
    const cls = await storage.table('gradebook_courses').get(assessment.class_id);
    if (cls) className = cls.name;
  }

  const isPractice = !assessment.class_id && assessment.mode !== 'graded';

  // Initial State: Show Student Start Card
  container.innerHTML = `
    <div class="max-w-xl mx-auto py-8 px-4" id="kiosk-start-view">
      <div class="bg-white p-6 sm:p-8 rounded-2xl border border-slate-200 shadow-xl space-y-6 text-center">
        <div class="w-16 h-16 rounded-2xl ${isPractice ? 'bg-emerald-100 text-emerald-600' : 'bg-blue-100 text-blue-600'} flex items-center justify-center mx-auto text-3xl shadow-sm">
          <sl-icon name="${isPractice ? 'lightbulb' : 'mortarboard'}"></sl-icon>
        </div>

        <div>
          <h1 class="text-2xl font-bold text-slate-900">${safeTitle}</h1>
          ${isPractice
            ? '<p class="text-xs font-semibold text-emerald-600 uppercase tracking-wider mt-1">Formative Practice · Ungraded</p>'
            : (className ? `<p class="text-xs font-semibold text-blue-600 uppercase tracking-wider mt-1">${Sanitizer.escapeHTML(className)}</p>` : '')}
          <p class="text-sm text-slate-500 mt-2">
            This interactive video lesson has <strong>${questionCount} question${questionCount === 1 ? '' : 's'}</strong> worth <strong>${maxScore} point${maxScore === 1 ? '' : 's'}</strong>.
          </p>
        </div>

        <div class="bg-slate-50 p-4 rounded-xl border border-slate-200 text-left space-y-3">
          ${isPractice ? `
            <sl-input id="input-student-name" label="Your name (optional for practice)" placeholder="e.g. Jane Doe"></sl-input>
            <p class="text-xs text-slate-500">Practice at your own pace. Checkpoints give instant feedback with unlimited attempts.</p>
          ` : `
            <sl-input id="input-student-name" label="Full name" placeholder="e.g. Jane Doe" required></sl-input>
            <sl-input id="input-student-id" label="${rosterChecks ? 'Student ID' : 'Student ID (optional)'}" placeholder="e.g. S104" ${rosterChecks ? 'required' : ''}></sl-input>
            <sl-input id="input-student-code" type="password" password-toggle label="${rosterChecks ? 'Access code' : 'Access code (if your teacher gave you one)'}" placeholder="e.g. K7M2-QX9P" ${rosterChecks ? 'required' : ''}></sl-input>
          `}
          <p id="kiosk-start-error" class="hidden text-xs font-medium text-red-600" role="alert"></p>
        </div>

        <div class="space-y-2">
          <sl-button variant="primary" size="large" class="w-full" id="btn-begin-assessment">
            <sl-icon slot="prefix" name="play-fill"></sl-icon> ${isPractice ? 'Start Video Lesson' : 'Begin Assessment'}
          </sl-button>
          <sl-button variant="text" size="small" id="btn-kiosk-exit" class="w-full text-slate-500">
            Exit
          </sl-button>
        </div>
      </div>
    </div>

    <!-- Active Assessment View (hidden initially) -->
    <div class="max-w-4xl mx-auto space-y-4 hidden" id="kiosk-active-view">
      <div class="flex items-center justify-between bg-white p-3 rounded-xl border shadow-sm">
        <div class="flex items-center gap-2">
          <sl-icon name="mortarboard" class="text-blue-600 text-xl"></sl-icon>
          <span class="font-bold text-slate-800">${safeTitle}</span>
        </div>
        <div class="text-xs text-slate-500 font-mono">
          Student: <strong id="kiosk-header-student-name">Student</strong>
        </div>
      </div>

      <!-- Player Dock -->
      <div class="relative bg-black rounded-2xl overflow-hidden shadow-xl aspect-video flex items-center justify-center">
        <div id="kiosk-video-container" class="w-full h-full"></div>
        <div class="kb-video-shield" id="kiosk-shield"></div>
      </div>

      <!-- Custom Accessible Scrubber Bar with Visual Checkpoint Markers -->
      <div class="bg-white p-3 rounded-xl border border-slate-200 shadow-sm space-y-2">
        <div class="relative flex items-center h-8 px-1">
          <input type="range" id="kiosk-scrubber" min="0" max="100" value="0" class="w-full cursor-pointer z-10" />
          <div id="kiosk-scrubber-markers" class="absolute inset-x-2 top-1/2 -translate-y-1/2 pointer-events-none h-3"></div>
        </div>

        <div class="flex items-center justify-between text-xs text-slate-600">
          <div class="flex items-center gap-2">
            <sl-button size="small" id="btn-kiosk-play" variant="primary">
              <sl-icon name="play-fill" id="icon-kiosk-play"></sl-icon>
            </sl-button>
            <span id="kiosk-time-display" class="font-mono">0:00 / 0:00</span>
          </div>
          <span class="text-slate-400 font-mono" id="kiosk-progress-text">0 / ${checkpoints.length} answered</span>
        </div>
      </div>
    </div>
  `;

  const startView = container.querySelector('#kiosk-start-view');
  const activeView = container.querySelector('#kiosk-active-view');
  const beginBtn = container.querySelector('#btn-begin-assessment');
  const exitBtn = container.querySelector('#btn-kiosk-exit');
  const nameInput = container.querySelector('#input-student-name');
  const idInput = container.querySelector('#input-student-id');
  const codeInput = container.querySelector('#input-student-code');
  const startError = container.querySelector('#kiosk-start-error');
  const showStartError = (msg) => {
    startError.textContent = msg;
    startError.classList.remove('hidden');
  };

  const shareParams = store.getState('shareParams') || {};
  const currentParams = router.currentParams || {};
  const initialSid = currentParams.sid || shareParams.sid || '';
  const initialSname = currentParams.sname || shareParams.sname || '';

  if (initialSname && nameInput) nameInput.value = initialSname;
  if (initialSid && idInput) {
    idInput.value = initialSid;
    idInput.setAttribute('readonly', '');
    const changeLink = document.createElement('div');
    changeLink.className = 'mt-1 flex justify-end';
    changeLink.innerHTML = '<button type="button" class="text-xs text-blue-600 hover:text-blue-800 underline">Not you? Change</button>';
    changeLink.querySelector('button').addEventListener('click', () => {
      idInput.removeAttribute('readonly');
      idInput.focus();
      changeLink.remove();
    });
    idInput.parentNode.insertBefore(changeLink, idInput.nextSibling);
  }

  exitBtn?.addEventListener('click', () => router.navigate('#/video'));

  let cleanup = null;

  beginBtn?.addEventListener('click', async () => {
    const studentName = nameInput ? nameInput.value.trim() : '';
    const studentId = idInput ? idInput.value.trim() : '';
    const accessCode = codeInput ? normalizeAccessCode(codeInput.value) : '';
    startError.classList.add('hidden');

    if (isPractice) {
      const finalName = studentName || 'Student';
      startView.classList.add('hidden');
      activeView.classList.remove('hidden');

      const headerName = container.querySelector('#kiosk-header-student-name');
      if (headerName) headerName.textContent = finalName;

      cleanup = await startKioskSession(assessment, { studentName: finalName, studentId: 'self_study', accessCode: '' }, container, router);
      return;
    }

    if (!studentName) {
      showStartError('Please enter your name to begin.');
      return;
    }
    if (rosterChecks) {
      const expected = rosterChecks[studentId.toUpperCase()];
      if (!studentId || !expected) {
        showStartError('That student ID isn\'t on this class list. Check it with your teacher.');
        return;
      }
      if (!accessCode || (await SubmissionCrypto.accessCodeCheck(assessment.id, studentId, accessCode)) !== expected) {
        showStartError('That access code doesn\'t match your student ID.');
        return;
      }
    }

    startView.classList.add('hidden');
    activeView.classList.remove('hidden');

    const headerName = container.querySelector('#kiosk-header-student-name');
    if (headerName) headerName.textContent = studentName;

    cleanup = await startKioskSession(assessment, { studentName, studentId, accessCode }, container, router);
  });

  return () => {
    if (cleanup && typeof cleanup === 'function') cleanup();
  };
}

async function startKioskSession(assessment, student, container, router) {
  const videoContainer = container.querySelector('#kiosk-video-container');
  const scrubber = container.querySelector('#kiosk-scrubber');
  const scrubberMarkers = container.querySelector('#kiosk-scrubber-markers');
  const playBtn = container.querySelector('#btn-kiosk-play');
  const playIcon = container.querySelector('#icon-kiosk-play');
  const timeDisplay = container.querySelector('#kiosk-time-display');
  const progressText = container.querySelector('#kiosk-progress-text');

  const driver = createVideoDriver(assessment.provider || 'html5');
  await driver.mount(videoContainer, assessment.video_source);

  const responseLogs = [];
  let isPlaying = false;
  let duration = 0;
  let isFinished = false;

  const checkpoints = assessment.checkpoints || [];

  function updatePlayButton() {
    if (playIcon) playIcon.name = isPlaying ? 'pause-fill' : 'play-fill';
  }

  function renderKioskMarkers() {
    if (!scrubberMarkers || duration <= 0) return;
    const answeredIds = new Set(responseLogs.map(r => r.checkpointId));

    scrubberMarkers.innerHTML = checkpoints.map(cp => {
      const pct = Math.min(100, Math.max(0, (cp.timestamp_sec / duration) * 100));
      const isDone = answeredIds.has(cp.id);
      const bg = isDone ? 'bg-emerald-500' : 'bg-blue-500';
      return `
        <div class="absolute w-2.5 h-2.5 -ml-1.25 rounded-full ${bg} border border-white shadow-xs pointer-events-auto"
             style="left: ${pct}%; top: 50%; transform: translateY(-50%);"
             title="@${formatSeconds(cp.timestamp_sec)} Checkpoint">
        </div>
      `;
    }).join('');
  }

  let gatekeeper = null;
  gatekeeper = new VideoGatekeeper(driver, checkpoints, (cp) => {
    isPlaying = false;
    updatePlayButton();
    gatekeeper.renderCheckpointModal(cp, (res) => {
      responseLogs.push(res);
      if (progressText) {
        progressText.textContent = `${responseLogs.length} / ${checkpoints.length} answered`;
      }
      renderKioskMarkers();
      // Auto-resume after answering
      driver.play().then(() => {
        isPlaying = true;
        updatePlayButton();
      }).catch(() => {});
    });
  });

  // Checkpoints are answer-key free; correctness comes from salted hashes (if feedback is on)
  gatekeeper.secure = assessment.secure || null;
  gatekeeper.startLoop();

  // Auto-play initial video
  driver.play().then(() => {
    isPlaying = true;
    updatePlayButton();
  }).catch(() => {});

  playBtn?.addEventListener('click', async () => {
    if (isPlaying) {
      await driver.pause();
      isPlaying = false;
    } else {
      await driver.play();
      isPlaying = true;
    }
    updatePlayButton();
  });

  const timeUpdateInterval = setInterval(async () => {
    try {
      const cur = await driver.getCurrentTime();
      const dur = await driver.getDuration();
      if (dur > 0 && dur !== duration) {
        duration = dur;
        renderKioskMarkers();
      }
      if (timeDisplay) timeDisplay.textContent = `${formatSeconds(cur)} / ${formatSeconds(dur)}`;
      if (scrubber && dur > 0 && !scrubber.matches(':active')) {
        scrubber.value = (cur / dur) * 100;
      }

      // Completion check
      if (dur > 0 && cur >= dur - 0.5 && !isFinished && !document.getElementById('kiosk-completion-modal')) {
        isFinished = true;
        clearInterval(timeUpdateInterval);
        gatekeeper.stop();
        renderKioskCompletion(assessment, student, responseLogs, container, router);
      }
    } catch (_) {}
  }, 250);

  return () => {
    clearInterval(timeUpdateInterval);
    gatekeeper.stop();
    try { driver.destroy(); } catch (_) {}
  };
}

/**
 * Render Kiosk Completion & Cryptographic Receipt Screen
 */
async function renderKioskCompletion(assessment, student, responseLogs, container, router) {
  const isPractice = !assessment.class_id && assessment.mode !== 'graded';
  const releaseImmediately = assessment.settings?.release_grade_immediately !== false;

  const checkpoints = assessment.checkpoints || [];
  const maxScore = maxScoreOf(checkpoints);
  const earnedScore = responseLogs.reduce((sum, r) => sum + (Number(r.earnedPoints) || 0), 0);
  const instant = !!assessment.secure?.instant_feedback;
  const answered = responseLogs.filter(r => r.studentAnswer !== 'Viewed Note').length;
  const questionCount = checkpoints.filter(c => c.type !== 'note').length;

  let receiptText = '';
  let filename = 'receipt.kbr';
  if (!isPractice) {
    try {
      const receipt = await createSecureReceipt({
        payload: assessment,
        studentName: student.studentName,
        studentId: student.studentId,
        accessCode: student.accessCode,
        responseLogs
      });
      receiptText = receipt.text;
      filename = receipt.filename;
    } catch (err) {
      console.error('Receipt creation failed:', err);
      toast.danger('Could not create your receipt. Ask your teacher for help.');
    }
  }

  const fingerprint = assessment.secure?.key_fingerprint || '';
  const pct = maxScore > 0 ? Math.round((earnedScore / maxScore) * 100) : 0;

  // Persist submission into student ledger
  StudentLedger.recordSubmission({
    assignmentId: assessment.id,
    courseId: assessment.class_id || null,
    courseName: isPractice ? 'Self-Study' : 'Class Assessment',
    title: assessment.title || 'Video Assessment',
    studentId: student.studentId || (isPractice ? 'self_study' : ''),
    studentName: student.studentName || 'Student',
    clientScore: { earned: earnedScore, possible: maxScore, pending: 0 },
    receiptId: filename
  }).catch(() => {});

  const modal = document.createElement('div');
  modal.id = 'kiosk-completion-modal';
  modal.className = 'fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto';
  modal.innerHTML = `
    <div class="bg-white rounded-2xl p-6 sm:p-8 max-w-lg w-full space-y-6 shadow-2xl my-auto" role="dialog" aria-modal="true" aria-labelledby="kiosk-done-title">
      <div class="text-center space-y-2">
        <div class="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto text-2xl">
          <sl-icon name="check2-circle"></sl-icon>
        </div>
        <h2 id="kiosk-done-title" class="text-2xl font-bold text-slate-900">${isPractice ? 'Practice complete' : 'Video complete'}</h2>
        <p class="text-sm text-slate-500">Well done, <strong>${Sanitizer.escapeHTML(student.studentName)}</strong>. You answered ${answered} of ${questionCount} question${questionCount === 1 ? '' : 's'}.</p>
      </div>

      ${isPractice ? `
        <div class="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-center">
          <div class="text-xs font-semibold uppercase tracking-wider text-emerald-700">Formative Practice Score</div>
          <div class="text-3xl font-bold text-slate-900 tabular-nums mt-1">${earnedScore} / ${maxScore} <span class="text-base font-medium text-slate-500">(${pct}%)</span></div>
          <p class="text-xs text-slate-500 mt-1">Practice complete! Unlimited attempts with zero hand-in needed.</p>
        </div>
      ` : (releaseImmediately ? `
        <div class="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-center">
          <div class="text-xs font-semibold uppercase tracking-wider text-emerald-700">Graded Assessment · Score Released</div>
          <div class="text-3xl font-bold text-slate-900 tabular-nums mt-1">${earnedScore} / ${maxScore} <span class="text-base font-medium text-slate-500">(${pct}%)</span></div>
          <p class="text-xs text-slate-500 mt-1">Your teacher re-checks every answer, so the final grade may differ.</p>
        </div>
      ` : `
        <div class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-center">
          <div class="text-sm font-medium text-slate-700">Your answers are recorded.</div>
          <p class="text-xs text-slate-500 mt-1">Your teacher will review submissions and release your score.</p>
        </div>
      `)}

      ${!isPractice ? `
        <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
          <p class="text-sm font-semibold text-slate-900 flex items-center gap-2"><sl-icon name="box-arrow-up" class="text-amber-600"></sl-icon> Last step: hand in your receipt</p>
          <p class="text-xs text-slate-700 leading-relaxed">Nothing is sent automatically. Upload the receipt file where your teacher asked, or paste the receipt code.</p>
          <div class="flex flex-col sm:flex-row gap-2">
            <sl-button variant="primary" id="btn-download-kbr" class="flex-1" ${receiptText ? '' : 'disabled'}><sl-icon slot="prefix" name="download"></sl-icon> Download receipt</sl-button>
            <sl-button id="btn-copy-kbr" class="flex-1" ${receiptText ? '' : 'disabled'}><sl-icon slot="prefix" name="clipboard"></sl-icon> Copy receipt code</sl-button>
          </div>
          ${fingerprint ? `<p class="text-[11px] text-slate-500">Encrypted for your teacher's key <strong class="font-mono">${Sanitizer.escapeHTML(fingerprint)}</strong>. Classmates can't read or change it.</p>` : ''}
        </div>
      ` : ''}

      <div class="flex justify-center gap-2 flex-wrap">
        ${isPractice ? `
          <sl-button variant="primary" id="btn-practice-again"><sl-icon slot="prefix" name="arrow-counterclockwise"></sl-icon> Watch &amp; Practice Again</sl-button>
        ` : ''}
        <sl-button variant="text" id="btn-print-pdf"><sl-icon slot="prefix" name="printer"></sl-icon> Print summary</sl-button>
        <sl-button variant="text" id="btn-finish-exit">Done</sl-button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#btn-practice-again')?.addEventListener('click', async () => {
    modal.remove();
    await startKioskSession(assessment, student, container, router);
  });
  modal.querySelector('#btn-download-kbr')?.addEventListener('click', () => {
    KioskReportEngine.downloadKBRFile(receiptText, filename);
    toast.success('Receipt downloaded. Hand this file in to your teacher.');
  });
  modal.querySelector('#btn-copy-kbr')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(receiptText);
      toast.success('Receipt code copied. Paste it where your teacher asked.');
    } catch (_) {
      toast.warning('Copy failed — use Download receipt instead.');
    }
  });
  modal.querySelector('#btn-print-pdf')?.addEventListener('click', () => {
    KioskReportEngine.generatePDFReport({
      studentName: student.studentName,
      assessmentTitle: assessment.title,
      completedAt: new Date().toISOString(),
      totalScore: instant ? earnedScore : '—',
      maxScore,
      percent: instant ? pct : '—',
      signature: fingerprint ? `encrypted for teacher key ${fingerprint}` : 'n/a',
      responseLogs: responseLogs.map(r => ({ ...r, isCorrect: instant ? r.isCorrect : null }))
    });
  });
  modal.querySelector('#btn-finish-exit')?.addEventListener('click', () => {
    modal.remove();
    router.navigate(assessment.secure && !assessment.secure.local ? '#/' : '#/video');
  });
}

/**
 * Open a .kbr receipt with this device's teacher key and re-grade it from the local answer key.
 */
export async function openReceiptOnThisDevice(text) {
  const keys = await SubmissionCrypto.getOrCreateTeacherKeys(storage);
  return openReceipt(text, {
    teacherPrivateKey: keys.decryptionKeys || keys.privateKey,
    getAssessment: (id) => storage.table('video_assessments').get(id),
    getStudents: (courseId) => storage.table('gradebook_students').where('course_id').equals(courseId).toArray()
  });
}

const RECEIPT_ERRORS = {
  NOT_FOR_THIS_TEACHER: 'This receipt was encrypted for a different teacher key (another device or browser profile). Open it where the assessment was shared from, or restore that backup.',
  CORRUPTED_RECEIPT: 'The receipt is damaged or incomplete.',
  NOT_A_VIDEO_RECEIPT: 'This is not a video assessment receipt.',
  ASSESSMENT_NOT_FOUND: 'The video assessment for this receipt is not in your library.',
  CRYPTOGRAPHIC_SIGNATURE_MISMATCH: 'The receipt contents were changed after it was created.',
  CORRUPTED_OR_INVALID_FILE: 'This file is not a readable receipt.'
};

export function receiptErrorMessage(code) {
  return RECEIPT_ERRORS[code] || 'This receipt could not be read.';
}

function showReceiptResultDialog(result) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Receipt check';
  const esc = (v) => Sanitizer.escapeHTML(v ?? '');
  if (!result.ok) {
    dialog.innerHTML = `
      <div class="rounded-xl border border-rose-200 bg-rose-50 p-4 flex gap-3">
        <sl-icon name="shield-x" class="text-rose-600 text-xl flex-shrink-0"></sl-icon>
        <div class="text-sm text-slate-700"><p class="font-semibold text-slate-900">Receipt not accepted</p><p class="mt-1">${esc(receiptErrorMessage(result.error))}</p></div>
      </div>
      <sl-button slot="footer" variant="primary" class="kb-receipt-close">Close</sl-button>`;
  } else {
    const id = IDENTITY_LABELS[result.identity] || IDENTITY_LABELS.unsigned;
    const toneCls = { emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200', rose: 'bg-rose-50 text-rose-700 border-rose-200', amber: 'bg-amber-50 text-amber-700 border-amber-200' }[id.tone];
    dialog.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-lg font-bold text-slate-900">${esc(result.studentName)}</p>
            <p class="text-xs text-slate-500 tabular-nums">${esc(result.studentId || 'no student ID')} · ${esc((result.completedAt || '').replace('T', ' ').slice(0, 16))}</p>
          </div>
          <span class="text-xs font-semibold px-2 py-1 rounded-md border ${toneCls}" title="${esc(id.help)}">${id.text}</span>
        </div>
        <p class="text-xs text-slate-500">${esc(id.help)}</p>
        <div class="rounded-xl bg-slate-50 border border-slate-200 p-4 flex items-center justify-between">
          <span class="text-sm text-slate-600">${result.format === 'v2' ? 'Score (re-graded on this device)' : 'Score claimed in receipt'}</span>
          <span class="text-xl font-bold text-slate-900 tabular-nums">${Sanitizer.safeNumber(result.earned)} / ${Sanitizer.safeNumber(result.max)}</span>
        </div>
        ${result.format === 'v2' && result.clientScore && result.clientScore.earned !== result.earned ? `<p class="text-xs text-amber-700">The student's device reported ${Sanitizer.safeNumber(result.clientScore.earned)} points; the re-graded score above is what counts.</p>` : ''}
      </div>
      <sl-button slot="footer" variant="primary" class="kb-receipt-close">Close</sl-button>`;
  }
  document.body.appendChild(dialog);
  dialog.show();
  dialog.querySelector('.kb-receipt-close')?.addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });
}

export default renderVideoView;
