/**
 * Moving short codes between two screens: show a code (QR + copyable text), and receive one
 * (camera scan or paste). Used by device linking, co-teacher invites and direct transfers.
 */
import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';
import { showQrSequence, openQrScanner } from './qr-handoff.js';

const esc = (v) => Sanitizer.escapeHTML(v);

export function modal(label, html, buttons, { width = '560px', onReady = null } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('sl-dialog');
    dialog.label = label;
    dialog.style.setProperty('--width', `min(${width}, 96vw)`);
    dialog.innerHTML = `${html}<div slot="footer" class="flex flex-wrap justify-end gap-2">${buttons
      .map(b => `<sl-button data-value="${esc(b.value)}" variant="${b.variant || 'default'}">${esc(b.label)}</sl-button>`).join('')}</div>`;
    let result = null;
    dialog.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (!btn || !dialog.contains(btn)) return;
      result = { value: btn.dataset.value, dialog };
      dialog.hide();
    });
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target !== dialog) return;
      dialog.remove();
      resolve(result);
    });
    document.body.appendChild(dialog);
    onReady?.(dialog);
    dialog.show();
  });
}

export const copyBlock = (code) => `
  <details class="text-left text-xs mt-2">
    <summary class="cursor-pointer text-blue-700">No camera? Copy the code instead</summary>
    <textarea readonly class="w-full mt-2 font-mono text-[11px] border border-slate-200 rounded-lg p-2 h-24" data-code>${esc(code)}</textarea>
    <sl-button size="small" data-copy class="mt-1">Copy</sl-button>
  </details>`;

export function bindCopy(dialog) {
  dialog.querySelector('[data-copy]')?.addEventListener('click', async () => {
    const text = dialog.querySelector('[data-code]')?.value || '';
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied.');
    } catch (_) {
      dialog.querySelector('[data-code]')?.select();
    }
  });
}

/** Get a code from the other screen: camera scan, or paste */
export async function receiveCode({ label, intro }) {
  const choice = await modal(label, `
    <div class="space-y-3 text-sm">
      <p class="text-slate-700">${esc(intro)}</p>
      <sl-textarea id="dv-paste" rows="3" placeholder="…or paste the code here" class="font-mono"></sl-textarea>
    </div>`, [
    { value: 'cancel', label: 'Cancel' },
    { value: 'scan', label: 'Scan with camera' },
    { value: 'paste', label: 'Use pasted code', variant: 'primary' }
  ]);
  if (!choice || choice.value === 'cancel') return null;
  if (choice.value === 'paste') {
    const text = choice.dialog.querySelector('#dv-paste')?.value?.trim();
    return text || null;
  }
  return new Promise((resolve) => {
    let got = null;
    openQrScanner({
      label,
      once: true,
      readyText: 'Point the camera at the code on the other screen.',
      noCamera: 'This browser cannot use the camera. Paste the code instead.',
      onSubmission: (text) => { got = text; },
      onClose: () => resolve(got)
    });
  });
}

/** Show a code as (looping) QR codes with a copyable fallback */
export function showCode(code, { label, intro = '', hint = '', ariaLabel = 'Code' }) {
  return showQrSequence(code, { label, intro, hint, ariaLabel, footerHtml: copyBlock(code), onReady: bindCopy, tooLarge: 'This code is too long for QR codes. Use the copy option on the other device.' });
}

/**
 * Show a code and wait for the teacher/student to continue. Resolves true when they click
 * `nextLabel`, false when they close the dialog.
 */
export function showCodeAndWait(code, { label, intro = '', hint = '', ariaLabel = 'Code', nextLabel = 'Next' }) {
  return new Promise((resolve) => {
    let next = false;
    showQrSequence(code, {
      label,
      intro,
      hint,
      ariaLabel,
      tooLarge: 'This code is too long for QR codes. Use the copy option on the other device.',
      footerHtml: `${copyBlock(code)}<div class="pt-2"><sl-button variant="primary" data-next>${esc(nextLabel)}</sl-button></div>`,
      onReady: (dialog) => {
        bindCopy(dialog);
        dialog.querySelector('[data-next]')?.addEventListener('click', () => { next = true; dialog.hide(); });
        dialog.addEventListener('sl-after-hide', (e) => { if (e.target === dialog) resolve(next); });
      }
    }).then((dialog) => { if (!dialog) resolve(false); });
  });
}
