import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';
import { RelayTransport } from '../core/transport.js';
import { encodeQrFrames } from '../core/qr-transfer.js';
import { supportsDirectTransfer } from '../core/p2p.js';
import { getPolicy } from '../core/managed-config.js';

const esc = (v) => Sanitizer.escapeHTML(v);

/** More frames than this takes too long to scan; suggest direct transfer or a file instead */
const COMFORTABLE_QR_FRAMES = 12;

/**
 * Which ways to hand in work are available, best first. Pure, so it can be tested.
 * @param {object} ctx
 * @param {boolean} ctx.hasRelay - the assignment has a school-server drop box
 * @param {number|null} ctx.qrFrames - frames needed, or null when too large for QR
 * @param {boolean} ctx.canDirect - WebRTC available
 * @param {boolean} ctx.canShare - Web Share with files available
 * @param {boolean} ctx.hasEmail - the teacher gave a hand-in address
 */
export function rankSendOptions({ hasRelay, qrFrames, canDirect, canShare, hasEmail }) {
  const options = [];
  if (hasRelay) options.push({ id: 'server', icon: 'cloud-arrow-up', title: 'Hand in to the school server', text: 'One click. Your teacher collects it from the server.' });
  const qrOk = qrFrames !== null && qrFrames <= COMFORTABLE_QR_FRAMES;
  if (qrOk) options.push({ id: 'qr', icon: 'qr-code', title: 'Show QR codes to your teacher', text: qrFrames > 1 ? `Your teacher scans ${qrFrames} codes with their camera.` : 'Your teacher scans one code with their camera.' });
  if (canDirect) options.push({ id: 'direct', icon: 'wifi', title: 'Send directly to your teacher\'s device', text: 'Same Wi-Fi or network. Good for large work; may be blocked on some school networks.' });
  if (!qrOk && qrFrames !== null) options.push({ id: 'qr', icon: 'qr-code', title: 'Show QR codes to your teacher', text: `Needs ${qrFrames} codes, which takes a while to scan.` });
  options.push({ id: 'download', icon: 'download', title: 'Download the submission file', text: 'Upload the .kbsub file to your LMS (Google Classroom, Canvas, …).' });
  if (canShare) options.push({ id: 'share', icon: 'share', title: 'Share the file', text: 'Send it with another app on this device.' });
  if (hasEmail) options.push({ id: 'email', icon: 'envelope', title: 'Email your teacher', text: 'Opens your email; attach the downloaded file.' });
  options.push({ id: 'copy', icon: 'clipboard', title: 'Copy the submission code', text: 'Paste it wherever your teacher asked.' });
  return options;
}

function canShareFiles() {
  try {
    return typeof navigator.canShare === 'function' && typeof File !== 'undefined'
      && navigator.canShare({ files: [new File(['x'], 'x.kbsub', { type: 'text/plain' })] });
  } catch (_) {
    return false;
  }
}

export function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 100);
}

/**
 * Every way to hand in one encrypted submission, in one place.
 * @param {object} opts
 * @param {string} opts.text - KBSUB1 code
 * @param {string} opts.filename
 * @param {string} opts.title - assignment title
 * @param {string} opts.studentName
 * @param {string} [opts.studentId]
 * @param {string} [opts.receiptId]
 * @param {{ base_url?: string, drop_id: string, drop_secret?: string }|null} [opts.relay]
 * @param {string} [opts.email]
 * @param {(result: { method: string, receipt?: string }) => void} [opts.onHandedIn]
 */
export async function openSendSheet({ text, filename, title, studentName, studentId = '', receiptId = '', relay = null, email = '', onHandedIn = null }) {
  let qrFrames = null;
  try {
    qrFrames = (await encodeQrFrames(text)).length;
  } catch (_) {}
  const options = rankSendOptions({
    hasRelay: Boolean(relay?.drop_id),
    qrFrames,
    canDirect: supportsDirectTransfer() && getPolicy().allowDirectTransfer,
    canShare: canShareFiles(),
    hasEmail: Boolean(email)
  });

  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Hand in your work';
  dialog.style.setProperty('--width', 'min(560px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-2 text-sm">
      <p class="text-slate-600">Pick any one. Your work is encrypted; only your teacher can open it.</p>
      ${options.map((o, i) => `
        <button type="button" data-method="${o.id}" class="w-full text-left border ${i === 0 ? 'border-blue-400 bg-blue-50/60' : 'border-slate-200'} hover:border-blue-400 hover:bg-blue-50 rounded-xl p-3 flex gap-3 transition-colors">
          <sl-icon name="${o.icon}" class="text-xl text-blue-600 flex-shrink-0 mt-0.5"></sl-icon>
          <span><span class="font-semibold text-slate-900">${esc(o.title)}</span>${i === 0 ? ' <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800">Best</span>' : ''}
            <span class="block text-xs text-slate-600 mt-0.5">${esc(o.text)}</span></span>
        </button>`).join('')}
      ${qrFrames === null ? '<p class="text-xs text-slate-500">This submission is too large for QR codes.</p>' : ''}
    </div>
    <sl-button slot="footer" data-close>Close</sl-button>`;
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) dialog.remove(); });

  const done = (method, receipt) => onHandedIn?.({ method, receipt });

  dialog.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-method]');
    if (!btn) return;
    const method = btn.dataset.method;
    try {
      if (method === 'server') {
        btn.disabled = true;
        const res = await new RelayTransport({ baseUrl: relay.base_url || '' }).submitToDrop(relay.drop_id, text, { dropSecret: relay.drop_secret });
        toast.success('Handed in to the school server.');
        done('server', res.receiptId || res.receipt_id);
        dialog.hide();
      } else if (method === 'qr') {
        dialog.hide();
        const { showSubmissionQr } = await import('./qr-handoff.js');
        await showSubmissionQr(text, { title, studentName });
      } else if (method === 'direct') {
        dialog.hide();
        const { sendDirect } = await import('./direct-transfer.js');
        const result = await sendDirect(text, {
          label: 'Send to your teacher',
          receiverSteps: 'Your teacher opens the Inbox, chooses "Receive directly" and scans this code.'
        });
        if (result === 'sent') done('direct');
        else if (result === 'unreachable') openSendSheet({ text, filename, title, studentName, studentId, receiptId, relay, email, onHandedIn });
      } else if (method === 'download') {
        downloadText(text, filename);
        toast.success('Submission file downloaded. Now hand it in.');
      } else if (method === 'share') {
        await navigator.share({ files: [new File([text], filename, { type: 'text/plain' })], title, text: `Submission for ${title} - ${studentName}` });
      } else if (method === 'email') {
        const subject = `[${title}] ${studentName} ${studentId}`.trim();
        const body = `Hi,\n\nPlease find attached my submission file (${filename}) for "${title}".\nReceipt code: ${receiptId}\n\n(Remember to attach the downloaded .kbsub file to this email).`;
        downloadText(text, filename);
        window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      } else if (method === 'copy') {
        await navigator.clipboard.writeText(text);
        toast.success('Submission code copied. Paste it where your teacher asked.');
      }
    } catch (err) {
      btn.disabled = false;
      if (err?.name !== 'AbortError') toast.warning(`That didn't work (${err?.message || 'unknown error'}). Try another way.`);
    }
  });

  document.body.appendChild(dialog);
  dialog.show();
  return dialog;
}
