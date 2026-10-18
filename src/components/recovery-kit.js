import { storage } from '../core/storage.js';
import { KeyVault } from '../core/keyvault.js';
import { Sanitizer } from '../core/sanitizer.js';
import { renderQrSvg } from './qr-handoff.js';
import { toast } from '../utils/toast.js';

const esc = (v) => Sanitizer.escapeHTML(v);

/**
 * Recovery Kit dialog - shows the teacher's recovery code once, lets them print or download it,
 * and records that it was saved. Without the code, a backup cannot be opened on another device.
 */
export class RecoveryKit {
  static async open() {
    if (document.getElementById('kb-recovery-kit-dialog')) return;
    const dialog = document.createElement('sl-dialog');
    dialog.id = 'kb-recovery-kit-dialog';
    dialog.label = 'Your recovery kit';
    dialog.style.setProperty('--width', '520px');
    document.body.appendChild(dialog);
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target === dialog) dialog.remove();
    });

    const code = await KeyVault.getPendingRecoveryCode(storage);
    if (code) this._renderCode(dialog, code);
    else this._renderSaved(dialog, await KeyVault.status(storage));
    dialog.show();
  }

  static _renderCode(dialog, code) {
    dialog.innerHTML = `
      <div class="space-y-4 text-sm">
        <p class="text-slate-700">
          Your backups are encrypted. To open one on a new or reset computer, you need this
          <strong>recovery code</strong>. Nobody else has a copy, including your school and KennisBoost.
        </p>
        <div class="text-center font-mono text-lg font-bold tracking-wider bg-slate-50 border border-slate-200 rounded-xl py-4 px-2 select-all break-words" id="rk-code">${esc(code)}</div>
        <div class="flex flex-wrap gap-2 justify-center">
          <sl-button size="small" id="rk-print"><sl-icon slot="prefix" name="printer"></sl-icon>Print kit</sl-button>
          <sl-button size="small" id="rk-download"><sl-icon slot="prefix" name="download"></sl-icon>Download as text</sl-button>
          <sl-button size="small" id="rk-copy"><sl-icon slot="prefix" name="clipboard"></sl-icon>Copy</sl-button>
        </div>
        <p class="text-xs text-slate-500">
          Keep it somewhere other than this computer: a printed copy in a safe place, or a password manager.
          It will not be shown again once you confirm.
        </p>
        <sl-checkbox id="rk-confirm">I have saved my recovery code somewhere safe</sl-checkbox>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="rk-later">Remind me later</sl-button>
        <sl-button variant="primary" id="rk-done" disabled>Done</sl-button>
      </div>`;

    const done = dialog.querySelector('#rk-done');
    dialog.querySelector('#rk-confirm').addEventListener('sl-change', (e) => {
      done.disabled = !e.target.checked;
    });
    dialog.querySelector('#rk-print').addEventListener('click', () => this.print(code));
    dialog.querySelector('#rk-download').addEventListener('click', () => this.download(code));
    dialog.querySelector('#rk-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        toast.success('Recovery code copied.');
      } catch (_) {
        toast.warning('Could not copy. Select the code and copy it manually.');
      }
    });
    dialog.querySelector('#rk-later').addEventListener('click', () => dialog.hide());
    done.addEventListener('click', async () => {
      await KeyVault.confirmRecoveryKitSaved(storage);
      toast.success('Recovery kit saved. Your backups can now be restored on any device.');
      window.dispatchEvent(new CustomEvent('kb-recovery-kit-saved'));
      dialog.hide();
    });
  }

  static _renderSaved(dialog, status) {
    const when = status.recoveryKitSavedAt ? new Date(status.recoveryKitSavedAt).toLocaleDateString() : null;
    dialog.innerHTML = `
      <div class="space-y-3 text-sm">
        ${when
          ? `<p class="text-slate-700">You saved your recovery kit on <strong>${esc(when)}</strong>. Keep using that code to restore backups.</p>`
          : '<p class="text-slate-700">There is no recovery code on record for your current backups. Create one now so your backups can be restored on another device.</p>'}
        <p class="text-xs text-slate-500">
          Lost it? Create a new code. Backups made from now on use the new code; older backup files
          still need the old one on other devices.
        </p>
      </div>
      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="rk-close">Close</sl-button>
        <sl-button variant="${when ? 'default' : 'primary'}" id="rk-rotate">Create a new recovery code</sl-button>
      </div>`;
    dialog.querySelector('#rk-close').addEventListener('click', () => dialog.hide());
    dialog.querySelector('#rk-rotate').addEventListener('click', async () => {
      const code = await KeyVault.rotateRecoveryCode(storage);
      this._renderCode(dialog, code);
    });
  }

  static print(code) {
    const w = window.open('', '_blank');
    if (!w) {
      toast.warning('Allow pop-ups to print your recovery kit.');
      return;
    }
    const date = new Date().toLocaleDateString();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>KennisBoost recovery kit</title>
      <style>
        body { font-family: system-ui, sans-serif; margin: 40px; color: #0f172a; max-width: 640px; }
        h1 { font-size: 22px; margin: 0 0 4px; }
        .muted { color: #64748b; font-size: 12px; }
        .code { font-family: ui-monospace, monospace; font-size: 24px; font-weight: 700; letter-spacing: .08em;
                border: 2px solid #0f172a; border-radius: 10px; padding: 16px; text-align: center; margin: 24px 0; }
        .qr { width: 180px; margin: 0 auto; }
        ol { font-size: 13px; line-height: 1.6; }
      </style></head><body>
      <h1>KennisBoost recovery kit</h1>
      <div class="muted">Created ${esc(date)}</div>
      <div class="code">${esc(code)}</div>
      <div class="qr">${renderQrSvg(code)}</div>
      <ol>
        <li>Store this page somewhere safe, away from your computer.</li>
        <li>To restore on a new device: open KennisBoost, choose <em>Backup &amp; storage → Restore backup</em>, pick your backup file and type this code.</li>
        <li>Anyone with this code <em>and</em> your backup file can read your class data. Do not share it.</li>
      </ol>
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  static download(code) {
    const text = [
      'KennisBoost recovery kit',
      `Created ${new Date().toLocaleDateString()}`,
      '',
      `Recovery code: ${code}`,
      '',
      'To restore on a new device: Backup & storage > Restore backup, pick your backup file and enter this code.',
      'Anyone with this code and your backup file can read your class data. Keep it private, and do not store it next to your backups.'
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kennisboost-recovery-kit.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 100);
  }
}

export default RecoveryKit;
