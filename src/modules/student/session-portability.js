import { storage } from '../../core/storage.js';
import { toast } from '../../utils/toast.js';
import { CryptoShareEngine } from '../../core/crypto-share.js';
import { StudentProfile } from '../../core/student-profile.js';
import { normalizeAccessCode } from '../../core/access-codes.js';

/**
 * Student Session Portability & Safe Shared Kiosks (KB-SESSION-002)
 * Proposal #2: Encrypted Session Keystores (.kbsession.enc) and Safe Departure wipe.
 */

export const SESSION_FILE_EXT = '.kbsession';
export const ENCRYPTED_SESSION_EXT = '.kbsession.enc';

/**
 * Export complete student workspace (courses, items, ledger, submissions, flashcards, keychain).
 * Defaults to encrypted AES-256-GCM envelope (.kbsession.enc).
 *
 * @param {object} [options]
 * @param {string} [options.studentId]
 * @param {string} [options.passphrase]
 * @param {'encrypted'|'cleartext'} [options.format='encrypted']
 * @returns {Promise<object>}
 */
export async function exportStudentSession({ studentId = null, passphrase = '', format = 'encrypted' } = {}) {
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
      // Resolve encryption passphrase: explicit passphrase > class access code in keychain
      let effectivePassphrase = (passphrase || '').trim();
      if (!effectivePassphrase) {
        // Search keychain for the first available access code
        const enrolledClasses = Object.values(keychain.classes || {});
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

      const envelope = {
        kbsession: 2,
        enc: 1,
        v: shareResult.version || shareResult.v || 2,
        format: 'encrypted',
        student_id: effectiveStudentId,
        exported_at: sessionData.exported_at,
        d: shareData.d
      };

      exportPayload = envelope;
      downloadFilename = `${baseFilename}${ENCRYPTED_SESSION_EXT}`;
    } else {
      // Cleartext legacy format
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
 * @returns {Promise<object>}
 */
export async function importStudentSession(fileOrText, passphrase = '') {
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

    // Check if file is encrypted (.kbsession.enc or kbsession: 2 with d payload)
    const isEncrypted = Boolean(parsed && (parsed.enc === 1 || parsed.enc === '1' || parsed.format === 'encrypted' || (parsed.kbsession === 2 && parsed.d)));

    if (isEncrypted) {
      let effectivePass = (passphrase || '').trim();

      // If no pass entered, check existing local keychain for matching candidate codes
      if (!effectivePass) {
        const localKeychain = StudentProfile.get();
        for (const cls of Object.values(localKeychain.classes || {})) {
          if (cls.access_code) {
            try {
              const unpacked = await CryptoShareEngine.unpackSharePayload(parsed.d, true, normalizeAccessCode(cls.access_code), parsed.v || 2);
              data = unpacked?.payload || unpacked;
              effectivePass = cls.access_code;
              break;
            } catch (_) {}
          }
        }
      }

      if (!effectivePass || data === parsed) {
        if (!effectivePass) {
          throw new Error('This session keystore is encrypted. Please enter your password or student access code.');
        }
        const unpacked = await CryptoShareEngine.unpackSharePayload(parsed.d, true, effectivePass, parsed.v || 2);
        data = unpacked?.payload || unpacked;
      }
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
    toast.danger('Could not restore session: ' + err.message);
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
