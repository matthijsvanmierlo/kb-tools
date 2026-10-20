import { storage } from '../../core/storage.js';
import { toast } from '../../utils/toast.js';

/**
 * Student Session Portability (KB-SESSION-001)
 * Export and restore entire student session state (.kbsession) across ephemeral Chromebooks.
 */

export async function exportStudentSession(studentId = null) {
  try {
    const [courses, items, ledger, submissions] = await Promise.all([
      storage.table('student_courses').toArray().catch(() => []),
      storage.table('student_items').toArray().catch(() => []),
      storage.table('student_ledger').toArray().catch(() => []),
      storage.table('assignment_submissions').toArray().catch(() => [])
    ]);

    const sessionData = {
      kennisboost_student_session: true,
      version: 1,
      exported_at: new Date().toISOString(),
      student_id: studentId,
      courses,
      items,
      ledger,
      submissions
    };

    const blob = new Blob([JSON.stringify(sessionData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `kennisboost-student-${studentId || 'session'}-${dateStr}.kbsession`;
    a.click();
    URL.revokeObjectURL(url);

    toast.success('Student session exported successfully!');
    return sessionData;
  } catch (err) {
    console.error('Failed to export student session:', err);
    toast.danger('Could not export student session: ' + err.message);
    throw err;
  }
}

export async function importStudentSession(fileOrText) {
  try {
    let content = fileOrText;
    if (typeof fileOrText !== 'string') {
      content = await fileOrText.text();
    }

    const data = JSON.parse(content);
    if (!data.kennisboost_student_session && !data.courses && !data.items) {
      throw new Error('Not a valid KennisBoost student session file (.kbsession)');
    }

    let restoredCourses = 0;
    let restoredItems = 0;
    let restoredLedger = 0;
    let restoredSubmissions = 0;

    if (Array.isArray(data.courses) && data.courses.length > 0) {
      const table = storage.table('student_courses');
      for (const c of data.courses) {
        await table.put(c);
        restoredCourses++;
      }
    }

    if (Array.isArray(data.items) && data.items.length > 0) {
      const table = storage.table('student_items');
      for (const it of data.items) {
        await table.put(it);
        restoredItems++;
      }
    }

    if (Array.isArray(data.ledger) && data.ledger.length > 0) {
      const table = storage.table('student_ledger');
      for (const entry of data.ledger) {
        await table.put(entry);
        restoredLedger++;
      }
    }

    if (Array.isArray(data.submissions) && data.submissions.length > 0) {
      const table = storage.table('assignment_submissions');
      for (const sub of data.submissions) {
        await table.put(sub);
        restoredSubmissions++;
      }
    }

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('kb-student-session-restored', {
        detail: { restoredCourses, restoredItems, restoredLedger, restoredSubmissions }
      }));
    }

    toast.success(`Session restored! (${restoredCourses} courses, ${restoredItems} items, ${restoredLedger} grade records)`);
    return {
      restoredCourses,
      restoredItems,
      restoredLedger,
      restoredSubmissions
    };
  } catch (err) {
    console.error('Failed to import student session:', err);
    toast.danger('Could not restore session: ' + err.message);
    throw err;
  }
}
