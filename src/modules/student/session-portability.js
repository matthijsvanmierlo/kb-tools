import { storage } from '../../core/storage.js';
import { toast } from '../../utils/toast.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { StudentProfile } from '../../core/student-profile.js';
import { normalizeAccessCode, formatAccessCode } from '../../core/access-codes.js';
import { Sanitizer } from '../../core/sanitizer.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

/**
 * Student Session Portability & Safe Shared Kiosks (KB-SESSION-002)
 *
 * Provides end-to-end encrypted session backup (.kbsession.enc) with:
 *  - Interactive unlock modal for Chromebooks with blank local keychains
 *  - Multi-recipient key wrapping (memorable student PIN + teacher class access codes)
 *  - Kiosk departure wiping for shared school devices
 */

export const SESSION_FILE_EXT = '.kbsession';
export const ENCRYPTED_SESSION_EXT = '.kbsession.enc';

/**
 * Attempt to decrypt an encrypted session envelope with a candidate passphrase or access code.
 * Tests direct decryption as well as any multi-recipient recovery slots.
 *
 * @param {object} envelope
 * @param {string} candidatePass
 * @returns {Promise<object|null>} Decrypted payload or null
 */
export async function attemptDecryptSessionEnvelope(envelope, candidatePass) {
  const normCandidate = String(candidatePass || '').trim();
  if (!normCandidate || !envelope?.d) return null;

  // 1. Direct decryption with candidatePass
  try {
    const unpacked = await CryptoShareEngine.unpackSharePayload(envelope.d, true, normCandidate, envelope.v || 2);
    if (unpacked) return unpacked?.payload || unpacked;
  } catch (_) {}

  // 2. Direct decryption with normalized access code (in case user entered code with or without hyphens)
  const normCode = normalizeAccessCode(normCandidate);
  if (normCode && normCode !== normCandidate) {
    try {
      const unpacked = await CryptoShareEngine.unpackSharePayload(envelope.d, true, normCode, envelope.v || 2);
      if (unpacked) return unpacked?.payload || unpacked;
    } catch (_) {}
  }

  // 3. Multi-recipient key-slot fallback (if student forgot their personal passphrase, any valid class code unlocks it)
  if (Array.isArray(envelope.recovery_slots) && envelope.recovery_slots.length > 0) {
    for (const slot of envelope.recovery_slots) {
      if (!slot?.d) continue;
      const codesToTry = [normCandidate, normCode].filter(Boolean);
      for (const p of codesToTry) {
        try {
          const slotUnpacked = await CryptoShareEngine.unpackSharePayload(slot.d, true, p, slot.v || 2);
          const masterPass = slotUnpacked?.payload?.master_pass || slotUnpacked?.master_pass;
          if (masterPass) {
            const masterUnpacked = await CryptoShareEngine.unpackSharePayload(envelope.d, true, masterPass, envelope.v || 2);
            if (masterUnpacked) return masterUnpacked?.payload || masterUnpacked;
          }
        } catch (_) {}
      }
    }
  }

  return null;
}

/**
 * Prompt student for a password or class access code to unlock an encrypted session file.
 *
 * @param {object} opts
 * @param {string} [opts.studentId]
 * @param {string} [opts.filename]
 * @returns {Promise<string|null>}
 */
export function promptSessionPassphraseDialog({ studentId = '', filename = '' } = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }

    const existing = document.getElementById('kb-unlock-session-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'kb-unlock-session-dialog';
    dialog.label = 'Unlock Student Session';
    dialog.style.setProperty('--width', '480px');

    dialog.innerHTML = `
      <form id="form-unlock-session" class="space-y-4">
        <div class="flex items-start gap-3 p-3 bg-blue-50/70 border border-blue-200 rounded-xl text-xs text-blue-900 leading-relaxed">
          <sl-icon name="shield-lock" class="text-blue-600 text-lg flex-shrink-0 mt-0.5"></sl-icon>
          <div>
            This backup keystore is encrypted to protect your grades, materials, and class keychain.
            ${studentId ? `<div class="mt-1 font-mono font-bold text-slate-800">Student ID: ${esc(studentId)}</div>` : ''}
          </div>
        </div>

        <sl-input 
          id="input-unlock-pass" 
          type="password" 
          password-toggle 
          label="Passphrase or Class Access Code" 
          placeholder="e.g. personal passphrase, PIN, or K7M2-QX9P" 
          help-text="Enter the password you used when saving, or any access code from your teacher."
          autofocus 
          required>
        </sl-input>

        <div id="unlock-session-error" class="hidden text-xs text-rose-600 bg-rose-50 border border-rose-200 p-2.5 rounded-lg flex items-center gap-2">
          <sl-icon name="exclamation-circle" class="flex-shrink-0"></sl-icon>
          <span id="unlock-session-error-text"></span>
        </div>

        <div slot="footer" class="flex justify-end gap-2">
          <sl-button type="button" id="btn-unlock-cancel">Cancel</sl-button>
          <sl-button type="submit" variant="primary" id="btn-unlock-submit">
            <sl-icon slot="prefix" name="unlock"></sl-icon> Unlock &amp; Resume
          </sl-button>
        </div>
      </form>
    `;

    document.body.appendChild(dialog);
    if (typeof dialog.show === 'function') dialog.show();

    let resolved = false;
    const cleanup = (val) => {
      if (resolved) return;
      resolved = true;
      if (typeof dialog.hide === 'function') dialog.hide();
      setTimeout(() => dialog.remove(), 200);
      resolve(val);
    };

    const form = dialog.querySelector('#form-unlock-session');
    const input = dialog.querySelector('#input-unlock-pass');
    const cancelBtn = dialog.querySelector('#btn-unlock-cancel');

    cancelBtn?.addEventListener('click', () => cleanup(null));
    dialog.addEventListener('sl-request-close', (e) => {
      if (e.target !== dialog) return;
      cleanup(null);
    });
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target !== dialog) return;
      cleanup(null);
    });

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = (input?.value || '').trim();
      if (!val) return;
      cleanup(val);
    });

    setTimeout(() => input?.focus(), 100);
  });
}

/**
 * Interactive Export Session Dialog
 * Allows student to choose a memorable password/PIN and automatically configures
 * teacher-assisted recovery slots using active class codes.
 */
export function openExportSessionDialog() {
  const existing = document.getElementById('kb-export-session-dialog');
  if (existing) existing.remove();

  const keychain = StudentProfile.get();
  const enrolledClasses = Object.values(keychain.classes || {}).filter(c => c.access_code);
  const studentId = keychain.defaultIdentity?.student_id || '';

  const dialog = document.createElement('sl-dialog');
  dialog.id = 'kb-export-session-dialog';
  dialog.label = 'Save & Protect Student Session';
  dialog.style.setProperty('--width', '520px');

  dialog.innerHTML = `
    <form id="form-export-dialog" class="space-y-4 text-sm">
      <p class="text-xs text-slate-500 leading-relaxed">
        Save an encrypted copy of all your enrolled classes, drafts, grades, and keychain. You can resume your work on any school Chromebook or laptop.
      </p>

      <sl-input 
        id="input-export-pass" 
        type="password" 
        password-toggle 
        label="Personal Passphrase or 6-Digit PIN (Recommended)" 
        placeholder="e.g. blue-ocean-42 or 6-digit PIN" 
        help-text="Choose a password you will remember on other school computers.">
      </sl-input>

      ${enrolledClasses.length > 0 ? `
        <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
          <sl-checkbox id="chk-allow-recovery" checked size="small">
            <span class="text-xs font-semibold text-slate-800">Enable Teacher Recovery Safety Net</span>
          </sl-checkbox>
          <p class="text-[11px] text-slate-500 leading-normal pl-6">
            If you ever forget your personal password, your teachers for <strong>${enrolledClasses.map(c => esc(c.course_name)).join(', ')}</strong> can give you your class access code to unlock this backup.
          </p>
        </div>
      ` : ''}

      <div class="pt-2 flex flex-col gap-2">
        <sl-button type="submit" variant="primary" class="w-full">
          <sl-icon slot="prefix" name="download"></sl-icon> Download Encrypted Session (.kbsession.enc)
        </sl-button>
        <button type="button" id="btn-export-raw-link" class="text-xs text-slate-400 hover:text-slate-600 text-center underline cursor-pointer pt-1">
          Export unencrypted backup (.kbsession)
        </button>
      </div>

      <div slot="footer" class="flex justify-end">
        <sl-button type="button" id="btn-export-dialog-cancel">Cancel</sl-button>
      </div>
    </form>
  `;

  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-export-dialog-cancel')?.addEventListener('click', () => dialog.hide());
  dialog.addEventListener('sl-after-hide', (e) => {
    if (e.target === dialog) dialog.remove();
  });

  dialog.querySelector('#form-export-dialog')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = dialog.querySelector('#input-export-pass')?.value.trim();
    const allowRecovery = dialog.querySelector('#chk-allow-recovery')?.checked ?? true;

    try {
      await exportStudentSession({
        studentId,
        passphrase: pass,
        format: 'encrypted',
        includeRecoverySlots: allowRecovery
      });
      dialog.hide();
    } catch (_) {}
  });

  dialog.querySelector('#btn-export-raw-link')?.addEventListener('click', async () => {
    try {
      await exportStudentSession({
        studentId,
        format: 'cleartext'
      });
      dialog.hide();
    } catch (_) {}
  });

  return dialog;
}

/**
 * Export complete student workspace (courses, items, ledger, submissions, flashcards, keychain).
 * Defaults to encrypted AES-256-GCM envelope (.kbsession.enc).
 *
 * @param {object} [options]
 * @param {string} [options.studentId]
 * @param {string} [options.passphrase]
 * @param {'encrypted'|'cleartext'} [options.format='encrypted']
 * @param {boolean} [options.includeRecoverySlots=true]
 * @returns {Promise<object>}
 */
export async function exportStudentSession({
  studentId = null,
  passphrase = '',
  format = 'encrypted',
  includeRecoverySlots = true
} = {}) {
  try {
    const keychain = StudentProfile.get();
    const effectiveStudentId = studentId || keychain.defaultIdentity?.student_id || null;

    const [courses, items, ledger, asgSubmissions, taskSubmissions, flashcards] = await Promise.all([
      storage.table('student_courses').toArray().catch(() => []),
      storage.table('student_items').toArray().catch(() => []),
      storage.table('student_ledger').toArray().catch(() => []),
      storage.table('assignment_submissions').toArray().catch(() => []),
      storage.table('task_submissions').toArray().catch(() => []),
      storage.table('flashcards').toArray().catch(() => [])
    ]);

    const sessionData = {
      kennisboost_student_session: true,
      version: 2,
      exported_at: new Date().toISOString(),
      student_id: effectiveStudentId,
      keychain,
      courses,
      items,
      ledger,
      submissions: asgSubmissions,
      task_submissions: taskSubmissions,
      flashcards
    };

    const dateStr = new Date().toISOString().slice(0, 10);
    const baseFilename = `kennisboost-student-${effectiveStudentId || 'session'}-${dateStr}`;

    let exportPayload = null;
    let downloadFilename = '';
    let mimeType = 'application/json';

    if (format === 'encrypted') {
      let effectivePassphrase = (passphrase || '').trim();
      const enrolledClasses = Object.values(keychain.classes || {});

      // Fallback: if student didn't type a passphrase, use their first class access code
      if (!effectivePassphrase) {
        for (const cls of enrolledClasses) {
          if (cls.access_code) {
            effectivePassphrase = normalizeAccessCode(cls.access_code);
            break;
          }
        }
      }

      if (!effectivePassphrase) {
        throw new Error('A password or student access code is required to encrypt this session keystore.');
      }

      const shareResult = await CryptoShareEngine.createSharePayload('student_session', sessionData, effectivePassphrase);
      let shareData = null;
      try {
        shareData = JSON.parse(shareResult.rawFileContent);
      } catch (_) {
        shareData = { d: '' };
      }

      // Generate multi-recipient recovery slots (Slot wrapping)
      const recoverySlots = [];
      if (includeRecoverySlots && enrolledClasses.length > 0) {
        for (const cls of enrolledClasses) {
          if (cls.access_code) {
            const normClsCode = normalizeAccessCode(cls.access_code);
            if (normClsCode && normClsCode !== normalizeAccessCode(effectivePassphrase)) {
              try {
                const slotShare = await CryptoShareEngine.createSharePayload('session_key_slot', { master_pass: effectivePassphrase }, normClsCode);
                const parsedSlot = JSON.parse(slotShare.rawFileContent);
                recoverySlots.push({
                  course_id: cls.course_id || null,
                  course_name: cls.course_name || 'Class',
                  d: parsedSlot.d,
                  v: parsedSlot.v || 2
                });
              } catch (_) {}
            }
          }
        }
      }

      const envelope = {
        kbsession: 2,
        enc: 1,
        v: shareResult.version || shareResult.v || 2,
        format: 'encrypted',
        student_id: effectiveStudentId,
        exported_at: sessionData.exported_at,
        d: shareData.d,
        recovery_slots: recoverySlots.length > 0 ? recoverySlots : undefined
      };

      exportPayload = envelope;
      downloadFilename = `${baseFilename}${ENCRYPTED_SESSION_EXT}`;
    } else {
      // Cleartext format
      exportPayload = sessionData;
      downloadFilename = `${baseFilename}${SESSION_FILE_EXT}`;
    }

    if (typeof document !== 'undefined') {
      const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadFilename;
      a.click();
      URL.revokeObjectURL(url);
    }

    toast.success(`Student session exported successfully as ${downloadFilename}!`);
    return { sessionData, envelope: exportPayload, filename: downloadFilename };
  } catch (err) {
    console.error('Failed to export student session:', err);
    toast.danger('Could not export student session: ' + err.message);
    throw err;
  }
}

/**
 * Import and restore student session state from a .kbsession or .kbsession.enc file.
 *
 * @param {string|File|Blob} fileOrText
 * @param {string} [passphrase='']
 * @param {object} [options]
 * @param {boolean} [options.promptIfRequired=true]
 * @returns {Promise<object>}
 */
export async function importStudentSession(fileOrText, passphrase = '', { promptIfRequired = true } = {}) {
  try {
    let content = fileOrText;
    if (typeof fileOrText !== 'string') {
      content = await fileOrText.text();
    }

    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      throw new Error('Not a valid JSON session file.');
    }

    let data = parsed;
    const isEncrypted = Boolean(parsed && (parsed.enc === 1 || parsed.enc === '1' || parsed.format === 'encrypted' || (parsed.kbsession === 2 && parsed.d)));

    if (isEncrypted) {
      let decryptedPayload = null;

      // 1. Try explicitly passed passphrase
      if (passphrase) {
        decryptedPayload = await attemptDecryptSessionEnvelope(parsed, passphrase);
      }

      // 2. Try candidate access codes in local keychain
      if (!decryptedPayload) {
        const localKeychain = StudentProfile.get();
        for (const cls of Object.values(localKeychain.classes || {})) {
          if (cls.access_code) {
            decryptedPayload = await attemptDecryptSessionEnvelope(parsed, cls.access_code);
            if (decryptedPayload) break;
          }
        }
      }

      // 3. If no passphrase was provided, candidate codes failed, and interactive prompt is permitted: show the unlock dialog
      if (!decryptedPayload && !passphrase && promptIfRequired && typeof document !== 'undefined') {
        let attempts = 0;
        while (!decryptedPayload && attempts < 3) {
          const userPass = await promptSessionPassphraseDialog({
            studentId: parsed.student_id,
            filename: typeof fileOrText === 'object' ? fileOrText.name : ''
          });

          if (!userPass) {
            throw new Error('Session unlock was cancelled.');
          }

          decryptedPayload = await attemptDecryptSessionEnvelope(parsed, userPass);
          if (!decryptedPayload) {
            toast.warning('Incorrect passphrase or access code. Try another class code or check with your teacher.');
            attempts++;
          }
        }
      }

      if (!decryptedPayload) {
        throw new Error('This session keystore is encrypted. Please enter your password or student access code.');
      }

      data = decryptedPayload;
    }

    if (!data || (!data.kennisboost_student_session && !data.courses && !data.items && !data.ledger)) {
      throw new Error('Not a valid KennisBoost student session file.');
    }

    let restoredCourses = 0;
    let restoredItems = 0;
    let restoredLedger = 0;
    let restoredSubmissions = 0;
    let restoredTasks = 0;

    // 1. Restore Courses
    if (Array.isArray(data.courses) && data.courses.length > 0) {
      const table = storage.table('student_courses');
      for (const c of data.courses) {
        await table.put(c);
        restoredCourses++;
      }
    }

    // 2. Restore Course Items
    if (Array.isArray(data.items) && data.items.length > 0) {
      const table = storage.table('student_items');
      for (const it of data.items) {
        await table.put(it);
        restoredItems++;
      }
    }

    // 3. Restore Ledger
    if (Array.isArray(data.ledger) && data.ledger.length > 0) {
      const table = storage.table('student_ledger');
      for (const entry of data.ledger) {
        await table.put(entry);
        restoredLedger++;
      }
    }

    // 4. Restore Assignment Submissions
    if (Array.isArray(data.submissions) && data.submissions.length > 0) {
      const table = storage.table('assignment_submissions');
      for (const sub of data.submissions) {
        await table.put(sub);
        restoredSubmissions++;
      }
    }

    // 5. Restore Task Submissions
    if (Array.isArray(data.task_submissions) && data.task_submissions.length > 0) {
      const table = storage.table('task_submissions');
      for (const tSub of data.task_submissions) {
        await table.put(tSub);
        restoredTasks++;
      }
    }

    // 6. Restore Flashcards
    if (Array.isArray(data.flashcards) && data.flashcards.length > 0) {
      const table = storage.table('flashcards');
      for (const fc of data.flashcards) {
        await table.put(fc);
      }
    }

    // 7. Restore Student Keychain
    if (data.keychain && typeof data.keychain === 'object') {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('kb_student_profile_v1', JSON.stringify(data.keychain));
        }
        await storage.setMetadata('student_profile', data.keychain).catch(() => {});
      } catch (_) {}
    }

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('kb-student-session-restored', {
        detail: { restoredCourses, restoredItems, restoredLedger, restoredSubmissions, restoredTasks }
      }));
    }

    toast.success(`Session restored! (${restoredCourses} courses, ${restoredLedger} grades, ${restoredSubmissions + restoredTasks} submissions)`);
    return {
      restoredCourses,
      restoredItems,
      restoredLedger,
      restoredSubmissions,
      restoredTasks
    };
  } catch (err) {
    console.error('Failed to import student session:', err);
    if (!err.message?.includes('cancelled')) {
      toast.danger('Could not restore session: ' + err.message);
    }
    throw err;
  }
}

/**
 * Kiosk Safe Departure: Securely wipe student session and local data from shared Chromebooks.
 *
 * @param {object} [options]
 * @param {boolean} [options.verifySaved=true]
 * @param {() => Promise<boolean>} [options.confirmFn]
 * @returns {Promise<boolean>}
 */
export async function wipeStudentKioskSession({ verifySaved = true, confirmFn = null } = {}) {
  try {
    if (verifySaved) {
      const [ledgerCount, subCount] = await Promise.all([
        storage.table('student_ledger').count().catch(() => 0),
        storage.table('assignment_submissions').count().catch(() => 0)
      ]);

      if (ledgerCount > 0 || subCount > 0) {
        let confirmed = true;
        if (typeof confirmFn === 'function') {
          confirmed = await confirmFn();
        } else if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          confirmed = window.confirm(
            'Are you sure you want to end your session? All local student grades, course links, and stored drafts will be permanently wiped from this device.'
          );
        }
        if (!confirmed) return false;
      }
    }

    // 1. Wipe student tables in IndexedDB
    const studentTables = [
      'student_courses',
      'student_items',
      'student_ledger',
      'assignment_submissions',
      'task_submissions'
    ];

    for (const tName of studentTables) {
      try {
        await storage.table(tName).clear();
      } catch (_) {}
    }

    // 2. Clear local storage student profiles and filters
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('kb_student_profile_v1');
      localStorage.removeItem('kb_active_class_filter');
      localStorage.removeItem('kb_recent_drafts');
    }

    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.clear();
    }

    // 3. Dispatch notification
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('kb-student-session-wiped'));
      window.location.hash = '#/student';
    }

    toast.info('Session ended and device wiped cleanly.');
    return true;
  } catch (err) {
    console.error('Failed to wipe student session:', err);
    toast.danger('Could not completely wipe session: ' + err.message);
    throw err;
  }
}
