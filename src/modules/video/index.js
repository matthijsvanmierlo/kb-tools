import { storage } from '../../core/storage.js';
import { store } from '../../state/store.js';
import { generateUUID } from '../../utils/uuid.js';
import { toast } from '../../utils/toast.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { createVideoDriver } from './drivers.js';
import { VideoGatekeeper } from './interceptor.js';
import { KioskReportEngine } from './kiosk-report.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';

/**
 * Video Assessment Module Controller (Editor & Kiosk Modes)
 */
export async function renderVideoView(params, router, container) {
  const isKiosk = params.kiosk === '1';

  let activeVideo = store.getState('activeVideo');
  const videoId = params.id;

  if (!activeVideo && videoId) {
    activeVideo = await storage.table('video_assessments').get(videoId);
  }

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
    return renderStudentKioskMode(activeVideo, container, router);
  }

  // Teacher / Authoring Mode
  return renderTeacherEditorMode(activeVideo, container, router);
}

async function renderStudentKioskMode(assessment, container, router) {
  let studentName = prompt('Enter your Student Name or ID to begin:', 'Student');
  if (!studentName || !studentName.trim()) studentName = 'Student';

  container.innerHTML = `
    <div class="max-w-4xl mx-auto space-y-4">
      <div class="flex items-center justify-between bg-white p-3 rounded-xl border shadow-sm">
        <div class="flex items-center gap-2">
          <sl-icon name="mortarboard" class="text-blue-600 text-xl"></sl-icon>
          <span class="font-bold text-slate-800">${assessment.title}</span>
        </div>
        <div class="text-xs text-slate-500 font-mono">
          Student: <strong>${Sanitizer.escapeHtml(studentName)}</strong>
        </div>
      </div>

      <!-- Player Dock -->
      <div class="relative bg-black rounded-2xl overflow-hidden shadow-xl aspect-video flex items-center justify-center">
        <div id="kiosk-video-container" class="w-full h-full"></div>
        <div class="kb-video-shield" id="kiosk-shield"></div>
      </div>

      <!-- Custom Accessible Scrubber Bar -->
      <div class="bg-white p-3 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
        <sl-button size="small" id="btn-kiosk-play" variant="primary">
          <sl-icon name="play-fill" id="icon-kiosk-play"></sl-icon>
        </sl-button>
        <span id="kiosk-time-display" class="text-xs font-mono text-slate-600">0:00 / 0:00</span>
        <div class="relative flex-1 flex items-center">
          <input type="range" id="kiosk-scrubber" min="0" max="100" value="0" class="w-full cursor-pointer" />
        </div>
      </div>

      <!-- Checkpoint Question Popover Dock -->
      <div id="kiosk-checkpoint-dock"></div>
    </div>
  `;

  const videoContainer = container.querySelector('#kiosk-video-container');
  const driver = createVideoDriver(assessment.provider);
  await driver.mount(videoContainer, assessment.video_source);

  const responseLogs = [];
  let isPlaying = false;

  const gatekeeper = new VideoGatekeeper(driver, assessment.checkpoints || [], (cp) => {
    isPlaying = false;
    updatePlayButton();
    gatekeeper.renderCheckpointModal(cp, (res) => {
      responseLogs.push(res);
      // Auto-resume after modal resolves
      driver.play();
      isPlaying = true;
      updatePlayButton();
    });
  });

  gatekeeper.startLoop();

  // Play / Pause toggle
  const playBtn = container.querySelector('#btn-kiosk-play');
  const playIcon = container.querySelector('#icon-kiosk-play');
  const timeDisplay = container.querySelector('#kiosk-time-display');
  const scrubber = container.querySelector('#kiosk-scrubber');

  function updatePlayButton() {
    if (playIcon) playIcon.name = isPlaying ? 'pause-fill' : 'play-fill';
  }

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

  // Time & Scrubber polling
  const formatTime = (sec) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const timeUpdateInterval = setInterval(async () => {
    const cur = await driver.getCurrentTime();
    const dur = await driver.getDuration();
    if (timeDisplay) timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    if (scrubber && dur > 0) scrubber.value = (cur / dur) * 100;

    // Detect video completion
    if (dur > 0 && cur >= dur - 0.5 && !container.querySelector('#kiosk-completion-modal')) {
      clearInterval(timeUpdateInterval);
      gatekeeper.stop();
      renderKioskCompletion(assessment, studentName, responseLogs, container);
    }
  }, 250);

  return () => {
    clearInterval(timeUpdateInterval);
    gatekeeper.stop();
    driver.destroy();
  };
}

async function renderKioskCompletion(assessment, studentName, responseLogs, container) {
  const checkpoints = assessment.checkpoints || [];
  const maxScore = checkpoints.reduce((sum, c) => sum + (c.points || 1), 0);
  const earnedScore = responseLogs.reduce((sum, r) => sum + (r.earnedPoints || 0), 0);

  const { receipt, kbrString, filename } = await KioskReportEngine.generateReceipt(
    studentName,
    assessment.id,
    assessment.title,
    responseLogs,
    earnedScore,
    maxScore
  );

  const modal = document.createElement('div');
  modal.id = 'kiosk-completion-modal';
  modal.className = 'fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="bg-white rounded-2xl p-6 sm:p-8 max-w-lg w-full text-center space-y-6 shadow-2xl">
      <div class="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto text-3xl">
        <sl-icon name="check2-circle"></sl-icon>
      </div>
      <div>
        <h2 class="text-2xl font-bold text-slate-800">Assessment Finished!</h2>
        <p class="text-sm text-slate-500 mt-1">Well done, <strong>${Sanitizer.escapeHtml(studentName)}</strong>. Your work has been cryptographically signed.</p>
      </div>

      <div class="bg-slate-50 p-4 rounded-xl border space-y-2 text-left">
        <div class="flex justify-between text-sm">
          <span class="text-slate-500">Total Score:</span>
          <span class="font-bold text-slate-900">${earnedScore} / ${maxScore} (${receipt.percent}%)</span>
        </div>
        <div class="flex justify-between text-xs">
          <span class="text-slate-500">Checkpoints Completed:</span>
          <span class="font-mono text-slate-700">${responseLogs.length} / ${checkpoints.length}</span>
        </div>
        <div class="pt-2 border-t text-[10px] text-slate-400 break-all font-mono">
          SHA-256 Digest: ${receipt.signature}
        </div>
      </div>

      <div class="flex flex-col sm:flex-row justify-center gap-2 pt-2">
        <sl-button variant="primary" id="btn-download-kbr">
          <sl-icon slot="prefix" name="file-earmark-check"></sl-icon> Download Receipt (.kbr)
        </sl-button>
        <sl-button variant="default" id="btn-print-pdf">
          <sl-icon slot="prefix" name="printer"></sl-icon> Print PDF
        </sl-button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#btn-download-kbr')?.addEventListener('click', () => {
    KioskReportEngine.downloadKBRFile(kbrString, filename);
    toast.success('Receipt downloaded! Submit this .kbr file to your teacher.');
  });

  modal.querySelector('#btn-print-pdf')?.addEventListener('click', () => {
    KioskReportEngine.generatePDFReport(receipt);
  });
}

async function renderTeacherEditorMode(activeVideo, container, router) {
  let videos = await storage.table('video_assessments').toArray();

  if (!activeVideo) {
    if (videos.length > 0) {
      activeVideo = videos[0];
    } else {
      // Seed sample video assessment
      activeVideo = {
        version: 1,
        id: generateUUID(),
        title: 'Introduction to Solar System',
        provider: 'html5',
        video_source: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
        checkpoints: [
          {
            id: generateUUID(),
            timestamp_sec: 5.0,
            type: 'single_choice',
            prompt_markdown: 'What is the closest planet to the Sun?',
            options: [
              { id: 'opt-1', text: 'Mercury', is_correct: true, rationale: 'Mercury is first from the Sun.' },
              { id: 'opt-2', text: 'Venus', is_correct: false, rationale: 'Venus is the second planet.' },
              { id: 'opt-3', text: 'Mars', is_correct: false, rationale: 'Mars is the fourth planet.' }
            ],
            points: 1
          },
          {
            id: generateUUID(),
            timestamp_sec: 15.0,
            type: 'open_response',
            prompt_markdown: 'Name one key characteristic of Jupiter.',
            keywords: ['gas', 'giant', 'red spot', 'largest', 'storm'],
            points: 2
          }
        ]
      };
      await storage.table('video_assessments').put(activeVideo);
      videos = [activeVideo];
    }
  }

  container.innerHTML = `
    <div class="space-y-4">
      <!-- Top Dock -->
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div class="flex items-center gap-3">
          <sl-icon name="camera-video" class="text-2xl text-blue-600"></sl-icon>
          <div>
            <h2 class="font-bold text-slate-900 text-lg">${activeVideo.title}</h2>
            <p class="text-xs text-slate-500">${activeVideo.checkpoints?.length || 0} interactive checkpoint(s)</p>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <sl-button size="small" id="btn-launch-kiosk" variant="primary">
            <sl-icon slot="prefix" name="play-circle"></sl-icon> Test Kiosk View
          </sl-button>
          <sl-button size="small" id="btn-verify-receipt" variant="default">
            <sl-icon slot="prefix" name="shield-check"></sl-icon> Verify .kbr Receipt
          </sl-button>
          <sl-button size="small" id="btn-share-video" variant="neutral">
            <sl-icon slot="prefix" name="share"></sl-icon> Share Lesson...
          </sl-button>
          <input type="file" id="input-kbr-verify" accept=".kbr" class="hidden" />
        </div>
      </div>

      <!-- Main Workspace: Video Player + Checkpoint Editor -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <!-- Video Player Column -->
        <div class="lg:col-span-7 bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
          <div class="relative bg-black rounded-xl overflow-hidden aspect-video flex items-center justify-center">
            <div id="editor-video-mount" class="w-full h-full"></div>
          </div>

          <div class="flex items-center justify-between text-xs text-slate-600">
            <div class="flex items-center gap-2">
              <sl-button size="small" id="btn-editor-play">Play / Pause</sl-button>
              <span id="editor-time-display" class="font-mono">0:00</span>
            </div>
            <sl-button size="small" variant="primary" id="btn-add-checkpoint-now">
              <sl-icon slot="prefix" name="plus-circle"></sl-icon> Add Checkpoint Here
            </sl-button>
          </div>
        </div>

        <!-- Checkpoints List Column -->
        <div class="lg:col-span-5 bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between">
          <div>
            <h3 class="font-bold text-slate-800 text-sm pb-2 border-b">Checkpoints Timeline</h3>
            <div class="space-y-2 py-3 overflow-y-auto max-h-96" id="checkpoints-list-container">
              ${(activeVideo.checkpoints || []).map((cp, i) => `
                <div class="p-3 border rounded-lg bg-slate-50 hover:bg-slate-100 flex items-start justify-between gap-2 text-xs">
                  <div>
                    <span class="font-bold text-blue-600 mr-1.5 font-mono">@${cp.timestamp_sec.toFixed(1)}s</span>
                    <span class="font-semibold text-slate-800 uppercase">[${cp.type}]</span>
                    <p class="text-slate-600 mt-1 line-clamp-2">${Sanitizer.escapeHtml(cp.prompt_markdown)}</p>
                  </div>
                  <button data-del-cp="${cp.id}" class="text-slate-400 hover:text-red-600 p-1" title="Delete Checkpoint">
                    <sl-icon name="trash"></sl-icon>
                  </button>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const videoMount = container.querySelector('#editor-video-mount');
  const driver = createVideoDriver(activeVideo.provider);
  await driver.mount(videoMount, activeVideo.video_source);

  let isPlaying = false;
  const playBtn = container.querySelector('#btn-editor-play');
  const timeDisplay = container.querySelector('#editor-time-display');

  playBtn?.addEventListener('click', async () => {
    if (isPlaying) {
      await driver.pause();
      isPlaying = false;
    } else {
      await driver.play();
      isPlaying = true;
    }
  });

  const pollInterval = setInterval(async () => {
    const cur = await driver.getCurrentTime();
    if (timeDisplay) timeDisplay.textContent = `${cur.toFixed(1)}s`;
  }, 250);

  // Add Checkpoint at current time
  container.querySelector('#btn-add-checkpoint-now')?.addEventListener('click', async () => {
    await driver.pause();
    isPlaying = false;
    const curTime = await driver.getCurrentTime();
    openAddCheckpointDialog(curTime, activeVideo, async () => {
      await storage.table('video_assessments').put(activeVideo);
      toast.success('Checkpoint added!');
      renderTeacherEditorMode(activeVideo, container, router);
    });
  });

  // Launch Kiosk Mode
  container.querySelector('#btn-launch-kiosk')?.addEventListener('click', () => {
    store.setState('activeVideo', activeVideo);
    router.navigate(`#/video?kiosk=1&id=${activeVideo.id}`);
  });

  // Share Lesson
  container.querySelector('#btn-share-video')?.addEventListener('click', () => {
    openShareDialog(activeVideo, 'video');
  });

  // Verify .kbr Receipt dropzone
  const kbrInput = container.querySelector('#input-kbr-verify');
  container.querySelector('#btn-verify-receipt')?.addEventListener('click', () => {
    kbrInput?.click();
  });

  kbrInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();
      const verification = await KioskReportEngine.verifyReceipt(content);

      if (verification.isValid) {
        toast.success(`Valid Cryptographic Receipt verified for ${verification.receipt.studentName}!`);
        showVerifiedReceiptDialog(verification.receipt);
      } else {
        toast.danger(`Receipt Verification Failed: ${verification.error}`);
      }
    } catch (err) {
      console.error('Verify error:', err);
      toast.danger('Invalid or unreadable .kbr receipt file.');
    } finally {
      kbrInput.value = '';
    }
  });

  // Delete Checkpoint
  container.querySelectorAll('[data-del-cp]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-del-cp');
      activeVideo.checkpoints = activeVideo.checkpoints.filter(c => c.id !== id);
      await storage.table('video_assessments').put(activeVideo);
      toast.info('Checkpoint removed.');
      renderTeacherEditorMode(activeVideo, container, router);
    });
  });

  return () => {
    clearInterval(pollInterval);
    driver.destroy();
  };
}

function openAddCheckpointDialog(timestamp, activeVideo, onSaved) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = `Add Question @ ${timestamp.toFixed(1)}s`;
  dialog.style.setProperty('--width', '520px');

  dialog.innerHTML = `
    <div class="space-y-3">
      <sl-select id="select-cp-type" label="Question Type" value="single_choice">
        <sl-option value="single_choice">Multiple Choice (Single Answer)</sl-option>
        <sl-option value="open_response">Open Response</sl-option>
        <sl-option value="note">Timestamp Note</sl-option>
      </sl-select>

      <sl-textarea id="input-cp-prompt" label="Question Prompt (Markdown supported)" rows="3" required></sl-textarea>

      <div id="cp-options-section" class="space-y-2">
        <label class="text-xs font-semibold text-slate-700">Options (Mark correct answer):</label>
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <input type="radio" name="correct-radio" checked value="0" />
            <sl-input class="flex-1 opt-text" placeholder="Option 1 (Correct)"></sl-input>
          </div>
          <div class="flex items-center gap-2">
            <input type="radio" name="correct-radio" value="1" />
            <sl-input class="flex-1 opt-text" placeholder="Option 2"></sl-input>
          </div>
        </div>
      </div>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-cp">Cancel</sl-button>
      <sl-button variant="primary" id="btn-save-cp">Save Checkpoint</sl-button>
    </div>
  `;

  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-save-cp')?.addEventListener('click', () => {
    const type = dialog.querySelector('#select-cp-type').value;
    const prompt = dialog.querySelector('#input-cp-prompt').value.trim();
    if (!prompt) {
      toast.warning('Please enter a question prompt.');
      return;
    }

    const optInputs = Array.from(dialog.querySelectorAll('.opt-text'));
    const checkedRadio = dialog.querySelector('input[name="correct-radio"]:checked');
    const correctIdx = checkedRadio ? Number(checkedRadio.value) : 0;

    const options = optInputs.map((inp, idx) => ({
      id: generateUUID(),
      text: inp.value.trim() || `Option ${idx + 1}`,
      is_correct: idx === correctIdx
    }));

    activeVideo.checkpoints.push({
      id: generateUUID(),
      timestamp_sec: Number(timestamp.toFixed(1)),
      type,
      prompt_markdown: prompt,
      options: type === 'single_choice' ? options : undefined,
      points: 1
    });

    dialog.remove();
    if (onSaved) onSaved();
  });

  dialog.querySelector('#btn-cancel-cp')?.addEventListener('click', () => dialog.remove());
}

function showVerifiedReceiptDialog(receipt) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Verified Student Performance Receipt';
  dialog.innerHTML = `
    <div class="space-y-3">
      <div class="bg-emerald-50 border border-emerald-200 p-3 rounded-lg flex items-center gap-2 text-emerald-800 text-sm">
        <sl-icon name="shield-check" class="text-xl"></sl-icon>
        <strong>Cryptographically Validated Signature</strong>
      </div>

      <div class="space-y-1 text-xs text-slate-700">
        <p><strong>Student:</strong> ${Sanitizer.escapeHtml(receipt.studentName)}</p>
        <p><strong>Score:</strong> ${receipt.totalScore} / ${receipt.maxScore} (${receipt.percent}%)</p>
        <p><strong>Completed At:</strong> ${receipt.completedAt}</p>
        <p class="font-mono text-slate-500 break-all"><strong>Signature:</strong> ${receipt.signature}</p>
      </div>
    </div>
    <sl-button slot="footer" variant="primary" id="btn-close-verify">Close</sl-button>
  `;
  document.body.appendChild(dialog);
  dialog.show();
  dialog.querySelector('#btn-close-verify')?.addEventListener('click', () => dialog.remove());
}

function openShareDialog(dataObject, moduleType) {
  const dialog = document.createElement('sl-dialog');
  dialog.label = `Share ${dataObject.title || 'Lesson'}`;
  dialog.innerHTML = `
    <div class="space-y-4">
      <p class="text-xs text-slate-500">Generate a zero-server encrypted URL that unpacks directly in any browser.</p>
      <sl-input id="input-share-password" type="password" password-toggle placeholder="Optional Passphrase to encrypt"></sl-input>
      <sl-button variant="primary" id="btn-gen-share" class="w-full">
        <sl-icon slot="prefix" name="link-45deg"></sl-icon> Generate Share Link
      </sl-button>
      <div id="share-result-box" class="hidden space-y-2 pt-2">
        <sl-input id="input-share-url" readonly></sl-input>
        <sl-button size="small" id="btn-copy-url">Copy Link</sl-button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-gen-share')?.addEventListener('click', async () => {
    const pass = dialog.querySelector('#input-share-password').value;
    const payload = await CryptoShareEngine.createSharePayload(moduleType, dataObject, pass);
    dialog.querySelector('#input-share-url').value = payload.url;
    dialog.querySelector('#share-result-box').classList.remove('hidden');
  });

  dialog.querySelector('#btn-copy-url')?.addEventListener('click', () => {
    navigator.clipboard.writeText(dialog.querySelector('#input-share-url').value);
    toast.success('Link copied to clipboard!');
  });
}

export default renderVideoView;
