/**
 * QR hand-in UI (KB-COMP-QR)
 *
 *  - Student: showSubmissionQr() loops the submission's QR frames on screen.
 *  - Teacher / Student: showQrSequence() displays single or animated QR code sequences with
 *    speed, density (easy-scan projector mode), play/pause, step, and frame selection controls.
 *  - Universal: openQrScanner() reads QR codes via camera or image file upload. Supports both
 *    animated KBQ1 streams and single-frame URLs/codes, with visual frame progress tracking.
 */
import qrcode from 'qrcode-generator';
import { encodeQrFrames, QrAssembler, QR_FRAME_CHARS, QR_FRAME_CHARS_EASY } from '../core/qr-transfer.js';
import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';

const esc = (v) => Sanitizer.escapeHTML(v);
const DEFAULT_FRAME_INTERVAL_MS = 900;

export function renderQrSvg(text, { cellSize = 4, margin = 16, errorCorrection = 'M' } = {}) {
  const qr = qrcode(0, errorCorrection);
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}

/**
 * Show a submission as looping QR codes for the teacher to scan.
 * @param {string} submissionText - KBSUB1 code
 * @param {{ title?: string, studentName?: string }} [info]
 */
export async function showSubmissionQr(submissionText, info = {}) {
  return showQrSequence(submissionText, {
    label: 'Show this to your teacher',
    intro: `${info.studentName || ''}${info.title ? ` · ${info.title}` : ''}`,
    ariaLabel: 'QR code for your encrypted submission',
    hint: 'Hold your screen steady in front of your teacher\'s camera{multi}. Turn your screen brightness up. Your answers are encrypted; only your teacher can read them.',
    tooLarge: 'This submission is too large for QR codes. Please download the file instead.'
  });
}

/**
 * Show any text or URL as a single QR code or animated sequence of KBQ1 frames.
 * @param {string} text
 * @param {{
 *   label?: string,
 *   title?: string,
 *   intro?: string,
 *   ariaLabel?: string,
 *   hint?: string,
 *   tooLarge?: string,
 *   footerHtml?: string,
 *   preferDirectUrl?: boolean,
 *   onReady?: (dialog: HTMLElement) => void
 * }} opts
 */
export async function showQrSequence(text, {
  label = '',
  title = '',
  intro = '',
  ariaLabel = 'QR code',
  hint = '',
  tooLarge = 'This is too large for QR codes.',
  footerHtml = '',
  preferDirectUrl = true,
  onReady = null
} = {}) {
  const dialogTitle = label || title || 'Share QR Code';
  const trimmed = String(text || '').trim();

  // If payload is small and is a URL or hash route, direct single-frame mode is preferred for native camera support
  const isDirectUrl = preferDirectUrl && trimmed.length <= 500 && (/^(https?:\/\/|#\/)/i.test(trimmed) || trimmed.startsWith('KB'));
  let currentDensity = 'standard'; // 'standard' (600 chars) or 'easy' (350 chars)
  let currentInterval = DEFAULT_FRAME_INTERVAL_MS;
  let frames = [];
  let svgs = [];

  const updateFrames = async (density) => {
    currentDensity = density;
    const chars = density === 'easy' ? QR_FRAME_CHARS_EASY : QR_FRAME_CHARS;
    if (isDirectUrl && density === 'standard' && trimmed.length <= 400) {
      frames = [trimmed];
    } else {
      frames = await encodeQrFrames(trimmed, { frameChars: chars });
    }
    svgs = frames.map(f => renderQrSvg(f));
  };

  try {
    await updateFrames('standard');
  } catch (err) {
    toast.warning(err.message === 'PAYLOAD_TOO_LARGE_FOR_QR' ? tooLarge : 'Could not create QR codes.');
    return null;
  }

  const dialog = document.createElement('sl-dialog');
  dialog.label = dialogTitle;
  dialog.style.setProperty('--width', 'min(600px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-3.5 text-center">
      ${intro ? `<p class="text-sm text-slate-600 font-medium">${esc(intro)}</p>` : ''}

      <!-- QR Frame Container -->
      <div class="kb-qr-frame-wrapper relative mx-auto p-3 bg-white rounded-2xl border border-slate-200 shadow-sm inline-block max-w-full transition-all">
        <div class="kb-qr-frame mx-auto" role="img" aria-label="${esc(ariaLabel)}"></div>
      </div>

      <!-- Part Indicator -->
      <p class="text-sm font-semibold text-slate-800" aria-live="polite">
        <span data-part></span>
      </p>

      <!-- Frame Pills (for jumping to specific frames) -->
      <div data-pills-container class="flex flex-wrap items-center justify-center gap-1.5 max-w-md mx-auto ${frames.length > 1 ? '' : 'hidden'}"></div>

      <!-- Playback Controls -->
      <div class="flex items-center justify-center gap-2 pt-1 flex-wrap ${frames.length > 1 ? '' : 'hidden'}">
        <sl-button size="small" data-step="-1" aria-label="Previous code" title="Previous frame">
          <sl-icon name="chevron-left"></sl-icon>
        </sl-button>
        <sl-button size="small" data-toggle variant="default" class="min-w-20 font-medium">Pause</sl-button>
        <sl-button size="small" data-step="1" aria-label="Next code" title="Next frame">
          <sl-icon name="chevron-right"></sl-icon>
        </sl-button>

        <!-- Speed Selector -->
        <sl-select size="small" data-speed value="900" class="w-28 text-left" aria-label="Playback speed">
          <sl-option value="1400">Slow (1.4s)</sl-option>
          <sl-option value="900">Normal (0.9s)</sl-option>
          <sl-option value="500">Fast (0.5s)</sl-option>
        </sl-select>

        <!-- Density / Projector Mode Toggle -->
        <sl-button size="small" data-density-toggle variant="text" title="Switch between high-density and easy-scan lower density for projectors" class="text-xs text-slate-600">
          <sl-icon name="projector" class="mr-1"></sl-icon>
          <span data-density-label>Easy Scan</span>
        </sl-button>
      </div>

      ${hint ? `<p class="text-xs text-slate-500 max-w-md mx-auto">${esc(hint.replace('{multi}', frames.length > 1 ? ' until every part is captured' : ''))}</p>` : ''}
      ${footerHtml}
    </div>
    <div slot="footer" class="flex items-center justify-between w-full">
      <span class="text-xs text-slate-500 font-medium">${frames.length > 1 ? 'Animated QR Stream' : 'Standard QR Code'}</span>
      <sl-button variant="primary" data-close>Done</sl-button>
    </div>`;

  const frameEl = dialog.querySelector('.kb-qr-frame');
  const partEl = dialog.querySelector('[data-part]');
  const pillsContainer = dialog.querySelector('[data-pills-container]');
  const toggleBtn = dialog.querySelector('[data-toggle]');
  const speedSelect = dialog.querySelector('[data-speed]');
  const densityToggle = dialog.querySelector('[data-density-toggle]');
  const densityLabel = dialog.querySelector('[data-density-label]');

  let index = 0;
  let timer = null;

  const renderPills = () => {
    if (frames.length <= 1) {
      pillsContainer.classList.add('hidden');
      return;
    }
    pillsContainer.classList.remove('hidden');
    pillsContainer.innerHTML = frames.map((_, i) => `
      <button type="button" data-frame-index="${i}" class="px-2 py-0.5 text-xs font-mono rounded-md border transition-all ${
        i === index
          ? 'bg-blue-600 text-white border-blue-600 font-bold shadow-sm'
          : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
      }">
        ${i + 1}
      </button>
    `).join('');

    pillsContainer.querySelectorAll('[data-frame-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        index = Number(btn.dataset.frameIndex);
        show();
      });
    });
  };

  const show = () => {
    if (!svgs[index]) index = 0;
    frameEl.innerHTML = svgs[index];
    partEl.textContent = frames.length > 1 ? `Frame ${index + 1} of ${frames.length}` : 'Ready to scan';
    renderPills();
  };

  const play = () => {
    clearInterval(timer);
    timer = setInterval(() => {
      index = (index + 1) % svgs.length;
      show();
    }, currentInterval);
  };

  toggleBtn?.addEventListener('click', () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      toggleBtn.textContent = 'Play';
    } else {
      play();
      toggleBtn.textContent = 'Pause';
    }
  });

  dialog.querySelectorAll('[data-step]').forEach(btn => btn.addEventListener('click', () => {
    index = (index + Number(btn.dataset.step) + svgs.length) % svgs.length;
    show();
  }));

  speedSelect?.addEventListener('sl-change', () => {
    currentInterval = Number(speedSelect.value) || DEFAULT_FRAME_INTERVAL_MS;
    if (timer) play();
  });

  densityToggle?.addEventListener('click', async () => {
    const nextDensity = currentDensity === 'standard' ? 'easy' : 'standard';
    try {
      await updateFrames(nextDensity);
      index = 0;
      densityLabel.textContent = nextDensity === 'easy' ? 'Standard Density' : 'Easy Scan';
      toast.info(nextDensity === 'easy' ? 'Switched to Easy Scan mode (lower density for projectors)' : 'Switched to Standard Density mode');
      show();
      if (svgs.length > 1 && timer) play();
    } catch (_) {
      toast.warning('Could not switch density.');
    }
  });

  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target !== dialog) return;
    clearInterval(timer);
    dialog.remove();
  });

  show();
  if (svgs.length > 1) play();
  document.body.appendChild(dialog);
  onReady?.(dialog);
  dialog.show();
  return dialog;
}

let jsQrPromise = null;
function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsQrPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../../vendor/jsQR.js', import.meta.url).href;
    script.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR missing')));
    script.onerror = () => reject(new Error('jsQR failed to load'));
    document.head.appendChild(script);
  });
  return jsQrPromise;
}

async function createDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (source) => (await detector.detect(source)).map(c => c.rawValue);
      }
    } catch (_) {}
  }
  const jsQR = await loadJsQr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (source) => {
    let w = 0;
    let h = 0;
    if (source instanceof HTMLVideoElement) {
      w = source.videoWidth;
      h = source.videoHeight;
    } else if (source instanceof HTMLCanvasElement || source instanceof HTMLImageElement || (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap)) {
      w = source.width;
      h = source.height;
    }
    if (!w || !h) return [];
    // Decoding at most ~1000px wide keeps jsQR fast enough on Chromebooks
    const scale = Math.min(1, 1000 / w);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return code ? [code.data] : [];
  };
}

/**
 * Detect and decode a QR code from an ImageBitmap, HTMLImageElement, HTMLCanvasElement, or HTMLVideoElement.
 * Unpacks single-frame KBQ1 frames or raw URLs/codes automatically.
 * @param {CanvasImageSource|ImageBitmap} source
 * @returns {Promise<string|null>}
 */
export async function scanQrFromSource(source) {
  const detect = await createDetector();
  const results = await detect(source);
  if (!results || !results.length) return null;
  const raw = results[0];
  const assembler = new QrAssembler({ allowSingleRaw: true });
  const r = await assembler.add(raw);
  if (r.status === 'complete') return r.text;
  return raw;
}

/**
 * Open the camera scanner. Accepts both animated KBQ1 multi-frame codes and single-frame raw URLs/codes.
 * Also supports scanning from image/screenshot files when camera is unavailable.
 * @param {{
 *   onSubmission?: (text: string) => Promise<void>|void,
 *   onResult?: (text: string) => Promise<void>|void,
 *   label?: string,
 *   once?: boolean,
 *   continuous?: boolean,
 *   readyText?: string,
 *   noCamera?: string,
 *   allowSingleRaw?: boolean,
 *   onClose?: () => void
 * }} opts
 */
export async function openQrScanner({
  onSubmission = null,
  onResult = null,
  label = 'Scan QR code',
  once = undefined,
  continuous = undefined,
  readyText = 'Point camera at the QR code (or upload an image)',
  noCamera = 'This browser cannot access the camera. You can scan from an image file below.',
  allowSingleRaw = true,
  onClose = null
} = {}) {
  const handleResult = onResult || onSubmission;
  if (!handleResult) {
    throw new Error('openQrScanner requires onResult or onSubmission callback');
  }

  // If once is specified, respect it. Otherwise, if continuous is false or onResult was passed, default once = true
  const isOnce = once !== undefined ? once : (continuous !== undefined ? !continuous : Boolean(onResult));

  const dialog = document.createElement('sl-dialog');
  dialog.label = label;
  dialog.style.setProperty('--width', 'min(640px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-3">
      <!-- Toolbar: Camera Switch & Image Upload -->
      <div class="flex items-center justify-between text-xs text-slate-600 gap-2">
        <span class="font-medium text-slate-700">Camera / Scanner</span>
        <div class="flex items-center gap-1.5">
          <sl-button size="small" data-btn-switch-cam class="hidden">
            <sl-icon slot="prefix" name="arrow-repeat"></sl-icon> Switch camera
          </sl-button>
          <sl-button size="small" data-btn-scan-img variant="default">
            <sl-icon slot="prefix" name="image"></sl-icon> Scan image file
          </sl-button>
          <input type="file" accept="image/*" data-img-input class="hidden" />
        </div>
      </div>

      <!-- Viewfinder -->
      <div class="kb-qr-scanner relative rounded-xl overflow-hidden bg-black flex items-center justify-center min-h-[260px]">
        <video playsinline muted aria-label="Camera preview" class="w-full h-full object-cover"></video>
        <div class="kb-qr-scanner-target" aria-hidden="true"></div>
      </div>

      <!-- Live Status & Feedback -->
      <p class="text-sm font-medium text-slate-800" aria-live="polite" data-status>Starting camera…</p>

      <!-- Frame Progress Grid (for multi-frame codes) -->
      <div data-frame-progress class="hidden p-2.5 bg-blue-50/80 border border-blue-200 rounded-lg space-y-1.5">
        <div class="flex items-center justify-between text-xs font-semibold text-blue-900">
          <span data-progress-title>Capturing multi-frame QR sequence...</span>
          <span data-progress-stats class="font-mono"></span>
        </div>
        <div data-progress-pills class="flex flex-wrap gap-1.5 pt-0.5"></div>
      </div>

      <ul class="text-xs text-slate-600 space-y-1" data-pending></ul>

      <p class="text-xs text-slate-500 leading-relaxed">
        Hold the camera steady in front of the code. Multi-frame animated sequences are assembled automatically in any order.
      </p>
    </div>
    <div slot="footer" class="flex items-center justify-between gap-2 w-full">
      <span class="text-sm font-semibold text-emerald-700 ${isOnce ? 'invisible' : ''}" data-count>0 collected</span>
      <sl-button variant="primary" data-close>Done</sl-button>
    </div>`;
  document.body.appendChild(dialog);

  const video = dialog.querySelector('video');
  const statusEl = dialog.querySelector('[data-status]');
  const pendingEl = dialog.querySelector('[data-pending]');
  const countEl = dialog.querySelector('[data-count]');
  const progressBox = dialog.querySelector('[data-frame-progress]');
  const progressTitle = dialog.querySelector('[data-progress-title]');
  const progressStats = dialog.querySelector('[data-progress-stats]');
  const progressPills = dialog.querySelector('[data-progress-pills]');
  const switchCamBtn = dialog.querySelector('[data-btn-switch-cam]');
  const scanImgBtn = dialog.querySelector('[data-btn-scan-img]');
  const imgInput = dialog.querySelector('[data-img-input]');

  const assembler = new QrAssembler({ allowSingleRaw });
  let stream = null;
  let running = true;
  let collected = 0;
  let videoDevices = [];
  let currentCameraIndex = 0;

  const stopCamera = () => {
    running = false;
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
  };

  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target !== dialog) return;
    stopCamera();
    dialog.remove();
    onClose?.();
  });
  dialog.show();

  // Detector setup
  let detect;
  try {
    detect = await createDetector();
  } catch (_) {
    statusEl.textContent = 'QR scanning is not supported in this browser.';
    stopCamera();
    return;
  }

  // Camera start helper
  const startCamera = async (deviceId = null) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      statusEl.textContent = noCamera;
      return;
    }
    stopCamera();
    running = true;
    try {
      const constraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      statusEl.textContent = readyText;

      // Check available devices
      if (navigator.mediaDevices.enumerateDevices) {
        const devs = await navigator.mediaDevices.enumerateDevices();
        videoDevices = devs.filter(d => d.kind === 'videoinput');
        if (videoDevices.length > 1) {
          switchCamBtn.classList.remove('hidden');
        }
      }
      tick();
    } catch (err) {
      statusEl.textContent = err?.name === 'NotAllowedError'
        ? 'Camera access was blocked. Check browser permissions or use "Scan image file".'
        : 'Could not start camera. You can still scan by uploading an image or screenshot below.';
    }
  };

  switchCamBtn?.addEventListener('click', async () => {
    if (videoDevices.length <= 1) return;
    currentCameraIndex = (currentCameraIndex + 1) % videoDevices.length;
    await startCamera(videoDevices[currentCameraIndex].deviceId);
  });

  // Image upload fallback
  scanImgBtn?.addEventListener('click', () => imgInput?.click());
  imgInput?.addEventListener('change', async () => {
    const file = imgInput.files?.[0];
    if (!file) return;
    imgInput.value = '';
    statusEl.textContent = 'Reading image file...';
    try {
      const bitmap = await createImageBitmap(file);
      const results = await detect(bitmap);
      if (!results || results.length === 0) {
        statusEl.textContent = 'No QR code found in the image. Please try a clearer screenshot.';
        toast.warning('No QR code detected in image.');
        return;
      }
      for (const raw of results) {
        await processDecodedRaw(raw);
      }
    } catch (err) {
      statusEl.textContent = 'Could not read image: ' + err.message;
    }
  });

  const renderFrameProgress = (r) => {
    if (!r || !r.total || r.total <= 1) {
      progressBox.classList.add('hidden');
      return;
    }
    progressBox.classList.remove('hidden');
    progressTitle.textContent = `Receiving multi-frame code (${r.received} of ${r.total} captured)`;
    progressStats.textContent = `${Math.round((r.received / r.total) * 100)}%`;

    const receivedSet = new Set(r.receivedIndices || []);
    progressPills.innerHTML = Array.from({ length: r.total }, (_, i) => i + 1).map(idx => {
      const isGot = receivedSet.has(idx);
      return `
        <span class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-mono ${
          isGot ? 'bg-emerald-600 text-white font-bold' : 'bg-white text-slate-500 border border-slate-300'
        }">
          ${idx} ${isGot ? '✓' : '·'}
        </span>
      `;
    }).join('');
  };

  const processDecodedRaw = async (raw) => {
    const r = await assembler.add(raw);
    if (r.status === 'complete') {
      collected++;
      countEl.textContent = `${collected} collected`;
      statusEl.textContent = 'Scanned successfully!';
      navigator.vibrate?.(80);
      progressBox.classList.add('hidden');

      if (isOnce) {
        dialog.hide();
        await handleResult(r.text);
        return true;
      }
      await handleResult(r.text);
      return true;
    } else if (r.status === 'progress') {
      statusEl.textContent = `Captured frame ${r.received} of ${r.total} — hold camera steady.`;
      renderFrameProgress(r);
    } else if (r.status === 'duplicate' && r.received === undefined) {
      statusEl.textContent = 'Code already scanned.';
    } else if (r.status === 'error') {
      statusEl.textContent = 'Corrupted frame. Please hold steady for the next pass.';
    }
    return false;
  };

  const tick = async () => {
    if (!running) return;
    try {
      const results = await detect(video);
      for (const raw of results) {
        const completed = await processDecodedRaw(raw);
        if (completed && isOnce) return;
      }
    } catch (err) {
      console.debug('QR tick detect:', err);
    }
    if (running) setTimeout(() => requestAnimationFrame(tick), 120);
  };

  await startCamera();
}
