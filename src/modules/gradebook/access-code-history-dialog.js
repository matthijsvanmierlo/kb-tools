import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { AccessCodes, formatAccessCode } from '../../core/access-codes.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

/**
 * Access Code History Dialog for Teachers (KB-ROSTER-008)
 *
 * Allows teachers to inspect, copy, and restore previous access codes for a student.
 * Essential for recovering student session keystores (.kbsession.enc) and in-progress
 * drafts that were encrypted with a retired access code.
 */
export function openAccessCodeHistoryDialog(student, course = {}, { onUpdated } = {}) {
  const existing = document.getElementById('kb-code-history-dialog');
  if (existing) existing.remove();

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'kb-code-history-dialog';
  dialog.label = `Access Code History · ${student.full_name || 'Student'}`;
  dialog.style.setProperty('--width', '520px');

  const history = Array.isArray(student.previous_access_codes) ? student.previous_access_codes : [];
  const currentCode = student.access_code ? formatAccessCode(student.access_code) : null;

  dialog.innerHTML = `
    <div class="space-y-4 text-sm">
      <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1">
        <div class="text-xs text-slate-500 font-medium">Current Active Code</div>
        <div class="flex items-center justify-between gap-3">
          <span class="font-mono text-base font-bold text-slate-900 tracking-wider">
            ${currentCode ? esc(currentCode) : '<span class="font-sans text-xs text-amber-700">No code assigned</span>'}
          </span>
          ${currentCode ? `
            <sl-button size="small" id="btn-copy-current-code">
              <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy
            </sl-button>
          ` : ''}
        </div>
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-bold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
            <sl-icon name="clock-history"></sl-icon> Retired Access Codes (${history.length})
          </h4>
          <span class="text-[11px] text-slate-400">Up to 5 past codes kept</span>
        </div>

        ${history.length === 0 ? `
          <div class="p-4 rounded-xl border border-dashed border-slate-200 text-center text-xs text-slate-400">
            No previous codes on record. This student is still using their initial access code.
          </div>
        ` : `
          <div class="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden bg-white">
            ${history.map((entry, idx) => {
              const codeFmt = formatAccessCode(entry.code || entry);
              const dateStr = entry.retired_at ? new Date(entry.retired_at).toLocaleString() : 'Date not recorded';
              return `
                <div class="p-3 flex items-center justify-between gap-3 hover:bg-slate-50/60 transition-colors">
                  <div>
                    <div class="font-mono text-sm font-semibold text-slate-800 tracking-wider">${esc(codeFmt)}</div>
                    <div class="text-[11px] text-slate-400 mt-0.5">Retired ${esc(dateStr)}</div>
                  </div>
                  <div class="flex items-center gap-1.5 flex-shrink-0">
                    <sl-button size="small" variant="default" class="btn-copy-history" data-code="${esc(codeFmt)}">
                      <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy
                    </sl-button>
                    <sl-button size="small" variant="default" class="btn-restore-history" data-code="${esc(entry.code || entry)}" data-idx="${idx}">
                      Restore
                    </sl-button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>

      <div class="p-3 bg-amber-50/80 border border-amber-200 rounded-xl text-xs text-amber-900 leading-relaxed flex items-start gap-2.5">
        <sl-icon name="info-circle" class="text-amber-600 mt-0.5 flex-shrink-0 text-sm"></sl-icon>
        <div>
          <strong>Why past codes matter:</strong> If this student has an older session backup (<code>.kbsession.enc</code>) or unsubmitted draft created before their code was reset, they can enter that past code to decrypt and recover their work.
        </div>
      </div>
    </div>

    <div slot="footer" class="flex justify-end gap-2">
      <sl-button id="btn-close-history" variant="primary">Done</sl-button>
    </div>
  `;

  document.body.appendChild(dialog);
  dialog.show();

  // Copy current code
  dialog.querySelector('#btn-copy-current-code')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentCode);
      toast.success('Active access code copied.');
    } catch (_) {
      toast.warning('Could not copy to clipboard.');
    }
  });

  // Copy history code
  dialog.querySelectorAll('.btn-copy-history').forEach(btn => {
    btn.addEventListener('click', async () => {
      const code = btn.dataset.code;
      try {
        await navigator.clipboard.writeText(code);
        toast.success(`Copied past code ${code}`);
      } catch (_) {
        toast.warning('Could not copy to clipboard.');
      }
    });
  });

  // Restore history code as active
  dialog.querySelectorAll('.btn-restore-history').forEach(btn => {
    btn.addEventListener('click', async () => {
      const codeToRestore = btn.dataset.code;
      const ok = await ConfirmDialog.show({
        title: 'Restore past access code?',
        message: `Restore <strong>${Sanitizer.escapeHTML(codeToRestore)}</strong> as ${Sanitizer.escapeHTML(student.full_name)}'s active code? Their current code will be archived in history.`,
        confirmText: 'Restore Code',
        variant: 'primary'
      });
      if (!ok) return;

      try {
        await AccessCodes.setCustom(student, codeToRestore);
        toast.success(`Restored ${codeToRestore} as active access code.`);
        dialog.hide();
        if (typeof onUpdated === 'function') onUpdated(student);
      } catch (err) {
        toast.danger('Could not restore access code: ' + err.message);
      }
    });
  });

  dialog.querySelector('#btn-close-history')?.addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target === dialog) dialog.remove();
  });

  return dialog;
}
