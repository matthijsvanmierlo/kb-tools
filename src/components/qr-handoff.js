/**
 * QR hand-in UI (KB-COMP-QR)
 *
 *  - Student: showSubmissionQr() loops the submission's QR frames on screen.
 *  - Teacher: openQrScanner() reads them with the device camera — BarcodeDetector where the
 *    browser has it (ChromeOS, Android, macOS), the self-hosted jsQR decoder elsewhere — and
 *    hands every completed submission to the normal inbox import (decrypt, verify, re-grade).
 */
import qrcode from 'qrcode-generator';
import { encodeQrFrames, QrAssembler } from '../core/qr-transfer.js';
import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';

const esc = (v) => Sanitizer.escapeHTML(v);
const FRAME_INTERVAL_MS = 1000;

export function renderQrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
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
 * Show any text as a looping sequence of QR codes (KBQ1 frames) in a dialog.
 * @param {string} text
 * @param {{ label: string, intro?: string, ariaLabel?: string, hint?: string, tooLarge?: string,
 *           footerHtml?: string, onReady?: (dialog: HTMLElement) => void }} opts
 *   hint may contain "{multi}", replaced when there is more than one frame
 */
export async function showQrSequence(text, { label, intro = '', ariaLabel = 'QR code', hint = '', tooLarge = 'This is too large for QR codes.', footerHtml = '', onReady = null }) {
  let frames;
  try {
    frames = await encodeQrFrames(text);
  } catch (err) {
    toast.warning(err.message === 'PAYLOAD_TOO_LARGE_FOR_QR' ? tooLarge : 'Could not create QR codes.');
    return null;
  }
  const svgs = frames.map(renderQrSvg);

  const dialog = document.createElement('sl-dialog');
  dialog.label = label;
  dialog.style.setProperty('--width', 'min(560px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-3 text-center">
      ${intro ? `<p class="text-sm text-slate-600">${esc(intro)}</p>` : ''}
      <div class="kb-qr-frame" role="img" aria-label="${esc(ariaLabel)}"></div>
      <p class="text-sm font-medium text-slate-700" aria-live="polite"><span data-part></span></p>
      <div class="flex justify-center gap-2 ${frames.length > 1 ? '' : 'hidden'}">
        <sl-button size="small" data-step="-1" aria-label="Previous code"><sl-icon name="chevron-left"></sl-icon></sl-button>
        <sl-button size="small" data-toggle>Pause</sl-button>
        <sl-button size="small" data-step="1" aria-label="Next code"><sl-icon name="chevron-right"></sl-icon></sl-button>
      </div>
      ${hint ? `<p class="text-xs text-slate-500">${esc(hint.replace('{multi}', frames.length > 1 ? ' until every part is captured' : ''))}</p>` : ''}
      ${footerHtml}
    </div>
    <sl-button slot="footer" variant="primary" data-close>Done</sl-button>`;

  const frameEl = dialog.querySelector('.kb-qr-frame');
  const partEl = dialog.querySelector('[data-part]');
  let index = 0;
  let timer = null;
  const show = () => {
    frameEl.innerHTML = svgs[index];
    partEl.textContent = frames.length > 1 ? `Code ${index + 1} of ${frames.length}` : '';
  };
  const play = () => {
    clearInterval(timer);
    timer = setInterval(() => { index = (index + 1) % svgs.length; show(); }, FRAME_INTERVAL_MS);
  };
  const toggle = dialog.querySelector('[data-toggle]');
  toggle?.addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; toggle.textContent = 'Play'; }
    else { play(); toggle.textContent = 'Pause'; }
  });
  dialog.querySelectorAll('[data-step]').forEach(btn => btn.addEventListener('click', () => {
    index = (index + Number(btn.dataset.step) + svgs.length) % svgs.length;
    show();
  }));
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
        return async (video) => (await detector.detect(video)).map(c => c.rawValue);
      }
    } catch (_) {}
  }
  const jsQR = await loadJsQr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return [];
    // Decoding at most ~1000px wide keeps jsQR fast enough on Chromebooks
    const scale = Math.min(1, 1000 / w);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return code ? [code.data] : [];
  };
}

/**
 * Open the camera scanner. Every completed submission is passed to onSubmission(text).
 * @param {{ onSubmission: (text: string) => Promise<void>|void, label?: string, once?: boolean,
 *           readyText?: string, noCamera?: string, onClose?: () => void }} opts
 *   once: close after the first complete code (device linking) instead of scanning a class
 */
export async function openQrScanner({
  onSubmission,
  label = 'Scan student QR codes',
  once = false,
  readyText = 'Point the camera at a student\'s QR code.',
  noCamera = 'This browser cannot use the camera. Ask students to download their .kbsub file instead.',
  onClose = null
}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast.warning(noCamera);
    onClose?.();
    return;
  }

  const dialog = document.createElement('sl-dialog');
  dialog.label = label;
  dialog.style.setProperty('--width', 'min(640px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-3">
      <div class="kb-qr-scanner">
        <video playsinline muted aria-label="Camera preview"></video>
        <div class="kb-qr-scanner-target" aria-hidden="true"></div>
      </div>
      <p class="text-sm text-slate-700" aria-live="polite" data-status>Starting camera…</p>
      <ul class="text-xs text-slate-600 space-y-1" data-pending></ul>
      <p class="text-xs text-slate-500">Scan one student at a time. Multi-part codes can be captured in any order; scanned work is added to the inbox below and checked like a file.</p>
    </div>
    <div slot="footer" class="flex items-center justify-between gap-2 w-full">
      <span class="text-sm font-semibold text-emerald-700" data-count>0 submissions collected</span>
      <sl-button variant="primary" data-close>Done</sl-button>
    </div>`;
  document.body.appendChild(dialog);

  const video = dialog.querySelector('video');
  const statusEl = dialog.querySelector('[data-status]');
  const pendingEl = dialog.querySelector('[data-pending]');
  const countEl = dialog.querySelector('[data-count]');
  const assembler = new QrAssembler();
  let stream = null;
  let running = true;
  let collected = 0;

  const stop = () => {
    running = false;
    stream?.getTracks().forEach(t => t.stop());
  };
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target !== dialog) return;
    stop();
    dialog.remove();
    onClose?.();
  });
  dialog.show();

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    statusEl.textContent = err?.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow the camera for this site in your browser settings and try again.'
      : 'No camera could be started on this device.';
    return;
  }

  let detect;
  try {
    detect = await createDetector();
  } catch (_) {
    statusEl.textContent = 'QR scanning is not available in this browser.';
    stop();
    return;
  }
  statusEl.textContent = readyText;
  if (once) {
    dialog.querySelector('[data-count]')?.classList.add('invisible');
    dialog.querySelector('.text-xs.text-slate-500')?.classList.add('hidden');
  }

  const renderPending = () => {
    pendingEl.innerHTML = assembler.pending()
      .map(p => `<li>Receiving a submission: ${esc(p.received)} of ${esc(p.total)} codes</li>`).join('');
  };

  const tick = async () => {
    if (!running) return;
    try {
      for (const raw of await detect(video)) {
        const r = await assembler.add(raw);
        if (r.status === 'complete') {
          collected++;
          countEl.textContent = `${collected} submission${collected === 1 ? '' : 's'} collected`;
          statusEl.textContent = 'Got it! Scan the next student.';
          navigator.vibrate?.(80);
          if (once) {
            dialog.hide();
            await onSubmission(r.text);
            return;
          }
          await onSubmission(r.text);
        } else if (r.status === 'progress') {
          statusEl.textContent = `Captured code ${r.received} of ${r.total} — keep holding steady.`;
        } else if (r.status === 'duplicate' && r.received === undefined) {
          statusEl.textContent = 'Already collected — scan the next student.';
        } else if (r.status === 'error') {
          statusEl.textContent = 'That code was damaged. Ask the student to show it again.';
        }
        renderPending();
      }
    } catch (err) {
      console.debug('QR detect failed:', err);
    }
    if (running) setTimeout(() => requestAnimationFrame(tick), 120);
  };
  tick();
}
