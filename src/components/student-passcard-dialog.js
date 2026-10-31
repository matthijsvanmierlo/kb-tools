import { StudentProfile } from '../core/student-profile.js';
import { Sanitizer } from '../core/sanitizer.js';
import { renderQrSvg } from './qr-handoff.js';
import { toast } from '../utils/toast.js';
import { getManagedConfig } from '../core/managed-config.js';
import { formatAccessCode } from '../core/access-codes.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

/**
 * Student Passcard Modal & Print Generator (KB-STUDENT-004)
 *
 * Provides a portable, physical or digital identity card with a QR code so students
 * on shared/ephemeral school hardware (Chromebooks, lab PCs) never lose their identity,
 * class roster entries, or access codes.
 */
export class StudentPasscardDialog {
  static open(profile = null) {
    const existing = document.getElementById('kb-student-passcard-dialog');
    if (existing) existing.remove();

    const prof = profile || StudentProfile.get();
    const config = getManagedConfig() || {};
    const schoolName = config.school?.name || 'KennisBoost Learning';
    const studentName = prof.defaultIdentity?.full_name || 'Student';
    const studentId = prof.defaultIdentity?.student_id || '—';
    const classes = Object.values(prof.classes || {});

    const passPayload = StudentProfile.createFullStudentPass();
    const passJson = JSON.stringify(passPayload);
    const qrSvg = renderQrSvg(passJson, { cellSize: 3, margin: 8, errorCorrection: 'M' });

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'kb-student-passcard-dialog';
    dialog.label = 'My Student Passcard';
    dialog.style.setProperty('--width', '540px');

    dialog.innerHTML = `
      <div class="space-y-5">
        <p class="text-xs text-slate-500">
          Keep this passcard safe. If your computer resets or you switch Chromebooks, scan this card to restore all your classes and access codes in one second.
        </p>

        <!-- Passcard Preview Container -->
        <div id="passcard-preview" class="bg-gradient-to-br from-slate-900 via-indigo-950 to-blue-950 text-white rounded-2xl p-5 shadow-lg border border-slate-700 relative overflow-hidden space-y-4">
          <!-- Background watermark decor -->
          <div class="absolute -right-12 -bottom-12 w-44 h-44 rounded-full bg-blue-500/10 blur-2xl pointer-events-none"></div>

          <div class="flex items-center justify-between border-b border-white/10 pb-3">
            <div>
              <div class="text-[10px] uppercase font-bold tracking-widest text-blue-300">${esc(schoolName)}</div>
              <div class="text-lg font-extrabold tracking-tight">${esc(studentName)}</div>
              <div class="text-xs text-slate-300 font-mono mt-0.5">Student ID: ${esc(studentId)}</div>
            </div>
            <div class="w-10 h-10 rounded-xl bg-blue-600/30 border border-blue-400/30 flex items-center justify-center text-blue-200">
              <sl-icon name="person-badge" class="text-xl"></sl-icon>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
            <!-- Classes List -->
            <div class="space-y-1.5 min-w-0">
              <div class="text-[10px] uppercase font-bold tracking-wider text-slate-400">Enrolled Classes</div>
              ${classes.length === 0 ? `
                <div class="text-xs text-slate-400 italic">No class codes saved yet.</div>
              ` : `
                <div class="space-y-1 max-h-36 overflow-y-auto pr-1">
                  ${classes.map(c => `
                    <div class="text-xs flex items-center justify-between gap-2 bg-white/5 px-2 py-1 rounded-lg border border-white/5">
                      <span class="truncate text-slate-200">${esc(c.course_name)}</span>
                      <span class="font-mono font-semibold text-blue-300 text-[11px] flex-shrink-0">${esc(c.access_code ? formatAccessCode(c.access_code) : 'No code')}</span>
                    </div>
                  `).join('')}
                </div>
              `}
            </div>

            <!-- QR Code -->
            <div class="flex flex-col items-center justify-center p-2 bg-white rounded-xl shadow-inner text-slate-900">
              <div class="w-32 h-32 flex items-center justify-center">
                ${qrSvg}
              </div>
              <span class="text-[10px] text-slate-500 font-medium mt-1">Scan on any device</span>
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="flex flex-wrap gap-2 justify-center pt-1">
          <sl-button size="small" variant="default" id="btn-print-passcard">
            <sl-icon slot="prefix" name="printer"></sl-icon> Print Passcard
          </sl-button>
          <sl-button size="small" variant="default" id="btn-copy-passcard-json">
            <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy Passcard Code
          </sl-button>
          <sl-button size="small" variant="default" id="btn-download-passcard-json">
            <sl-icon slot="prefix" name="download"></sl-icon> Save Passcard File
          </sl-button>
        </div>
      </div>

      <div slot="footer" class="flex justify-end gap-2">
        <sl-button id="btn-passcard-close" variant="primary">Close</sl-button>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    // Print Passcard
    dialog.querySelector('#btn-print-passcard')?.addEventListener('click', () => {
      StudentPasscardDialog.printPasscard(prof, schoolName, qrSvg);
    });

    // Copy Passcard
    dialog.querySelector('#btn-copy-passcard-json')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(passJson);
        toast.success('Passcard token copied! You can paste this on any device to restore your account.');
      } catch (_) {
        toast.warning('Could not copy passcard.');
      }
    });

    // Download Passcard JSON
    dialog.querySelector('#btn-download-passcard-json')?.addEventListener('click', () => {
      const blob = new Blob([passJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kennisboost-passcard-${studentId || 'student'}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
      toast.success('Passcard downloaded.');
    });

    dialog.querySelector('#btn-passcard-close')?.addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target === dialog) dialog.remove();
    });

    return dialog;
  }

  static printPasscard(prof, schoolName = 'KennisBoost Learning', qrSvg = null) {
    const w = window.open('', '_blank');
    if (!w) {
      toast.warning('Allow pop-ups to print your passcard.');
      return;
    }

    const studentName = prof.defaultIdentity?.full_name || 'Student';
    const studentId = prof.defaultIdentity?.student_id || '—';
    const classes = Object.values(prof.classes || {});
    const dateStr = new Date().toLocaleDateString();

    const passPayload = StudentProfile.createFullStudentPass();
    const passJson = JSON.stringify(passPayload);
    const finalQrSvg = qrSvg || renderQrSvg(passJson, { cellSize: 3, margin: 8, errorCorrection: 'M' });

    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Student Passcard — ${esc(studentName)}</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; margin: 30px; color: #0f172a; }
        .card {
          width: 380px;
          border: 2px solid #0f172a;
          border-radius: 16px;
          padding: 20px;
          background: #ffffff;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        .header { border-bottom: 2px solid #f1f5f9; padding-bottom: 12px; margin-bottom: 12px; }
        .school { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #475569; }
        .name { font-size: 18px; font-weight: 800; color: #0f172a; margin-top: 2px; }
        .id { font-size: 12px; font-family: monospace; color: #64748b; margin-top: 2px; }
        .body-grid { display: flex; gap: 16px; align-items: center; }
        .classes-col { flex: 1; min-width: 0; }
        .class-row { font-size: 11px; margin-bottom: 6px; padding: 4px 6px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0; }
        .c-name { font-weight: 600; color: #1e293b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .c-code { font-family: monospace; font-size: 11px; font-weight: 700; color: #2563eb; letter-spacing: .05em; }
        .qr-col { width: 120px; height: 120px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px solid #e2e8f0; border-radius: 12px; padding: 6px; }
        .instructions { font-size: 10px; color: #64748b; margin-top: 14px; line-height: 1.4; border-top: 1px dashed #cbd5e1; padding-top: 8px; }
      </style>
      </head><body>
        <div class="card">
          <div class="header">
            <div class="school">${esc(schoolName)}</div>
            <div class="name">${esc(studentName)}</div>
            <div class="id">Student ID: ${esc(studentId)} · Printed ${esc(dateStr)}</div>
          </div>
          <div class="body-grid">
            <div class="classes-col">
              <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 6px;">Enrolled Classes</div>
              ${classes.map(c => `
                <div class="class-row">
                  <div class="c-name">${esc(c.course_name)}</div>
                  <div class="c-code">${esc(c.access_code ? formatAccessCode(c.access_code) : '—')}</div>
                </div>
              `).join('') || '<div style="font-size: 11px; color: #94a3b8;">No classes added</div>'}
            </div>
            <div class="qr-col">
              <div style="width: 100px; height: 100px;">${finalQrSvg}</div>
              <div style="font-size: 8px; color: #64748b; margin-top: 4px; font-weight: 600;">Scan to log in</div>
            </div>
          </div>
          <div class="instructions">
            <strong>How to use:</strong> Open KennisBoost on any school device, click <em>Scan QR</em>, and point your camera at this card. All your courses and access codes will be restored automatically.
          </div>
        </div>
        <script>window.onload = () => window.print();<\/script>
      </body></html>`);
    w.document.close();
  }
}
