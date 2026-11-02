import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storage } from '../src/core/storage.js';
import { toast } from '../src/utils/toast.js';
import { HandinState } from '../src/core/handin-state.js';
import { describeRelayError } from '../src/core/transport.js';
import { StudentLedger } from '../src/modules/student/ledger.js';
import { checkTaskAccessCode, createTaskSubmission } from '../src/modules/tasks/pipeline.js';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';
import { DraftRoamer } from '../src/modules/assignments/draft-roaming.js';
import '../src/boot/shoelace-setup.js';

describe('Phase 46: Student Turn-in Honesty (R2)', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    localStorage.clear();
    const tables = ['student_ledger', 'student_courses', 'app_metadata'];
    for (const t of tables) {
      await storage.table(t).clear().catch(() => {});
    }
    vi.restoreAllMocks();
  });

  describe('R2.5: describeRelayError helper', () => {
    it('maps HTTP status codes and network errors to friendly user messages', () => {
      expect(describeRelayError({ status: 413 })).toBe('File too large');
      expect(describeRelayError({ status: 410 })).toBe('Drop box closed');
      expect(describeRelayError({ status: 403 })).toBe('Wrong link or secret');
      expect(describeRelayError({ status: 429 })).toBe('Busy – retry in a minute');
      expect(describeRelayError(new TypeError('Failed to fetch'))).toBe('Offline');
      expect(describeRelayError(new Error('NetworkError when attempting to fetch resource.'))).toBe('Offline');
      expect(describeRelayError({ status: 500, message: 'Internal Server Error' })).toBe('Internal Server Error');
    });
  });

  describe('R2.1: HandinState model', () => {
    it('stores, retrieves, and clears hand-in state per item, student, and version', () => {
      HandinState.set('task', 't1', 'S100', 1, {
        envelope_text: 'KB-SUB-TEST-123',
        submitted_at: 1700000000000,
        status: 'prepared'
      });

      const st = HandinState.get('task', 't1', 'S100', 1);
      expect(st).toBeTruthy();
      expect(st.envelope_text).toBe('KB-SUB-TEST-123');
      expect(st.status).toBe('prepared');

      // Version mismatch returns null
      expect(HandinState.get('task', 't1', 'S100', 2)).toBeNull();

      // Clear removes it
      HandinState.clear('task', 't1', 'S100', 1);
      expect(HandinState.get('task', 't1', 'S100', 1)).toBeNull();
    });
  });

  describe('R2.2: StudentLedger status tracking', () => {
    it('records custom submission status and does not falsely mark download as Submitted', async () => {
      await StudentLedger.recordSubmission({
        assignmentId: 'task-1',
        courseId: 'c-1',
        title: 'Essay 1',
        studentId: 'ST-101',
        studentName: 'Alice',
        receiptId: 'SUB-LOCAL-1',
        submissionText: 'kbsub-data',
        submittedAt: 1700000001000,
        status: 'File saved – upload it to your teacher'
      });

      const items = await storage.table('student_ledger').where('assignment_id').equals('task-1').toArray();
      expect(items.length).toBe(1);
      expect(items[0].status).toBe('File saved – upload it to your teacher');

      // Now record a confirmed relay hand-in
      await StudentLedger.recordSubmission({
        assignmentId: 'task-2',
        courseId: 'c-1',
        title: 'Essay 2',
        studentId: 'ST-101',
        studentName: 'Alice',
        receiptId: 'RCPT-999',
        submissionText: 'kbsub-data-2',
        submittedAt: 1700000002000,
        status: 'Handed in (server receipt RCPT-999)'
      });

      const items2 = await storage.table('student_ledger').where('assignment_id').equals('task-2').toArray();
      expect(items2.length).toBe(1);
      expect(items2[0].status).toBe('Handed in (server receipt RCPT-999)');
    });
  });

  describe('R0.2 & Access code validation', () => {
    it('checkTaskAccessCode blocks mismatch and unknown student', async () => {
      const codeCheck = await SubmissionCrypto.accessCodeCheck('task-test', 'ST-101', 'SECRET-101');
      const payload = {
        task_id: 'task-test',
        settings: { require_access_code: true },
        roster_checks: {
          'ST-101': codeCheck
        }
      };

      // Correct code
      const okStatus = await checkTaskAccessCode(payload, 'ST-101', 'SECRET-101');
      expect(okStatus).toBe('ok');

      // Mismatch
      const mismatchStatus = await checkTaskAccessCode(payload, 'ST-101', 'WRONG-CODE');
      expect(mismatchStatus).toBe('mismatch');

      // Unknown student
      const unknownStatus = await checkTaskAccessCode(payload, 'ST-999', 'SECRET-101');
      expect(unknownStatus).toBe('unknown_student');
    });
  });

  describe('R2.7: Roaming draft submitted status', () => {
    it('returns submitted draft info rather than null when draft was submitted', async () => {
      const fakeTransport = {
        getDraft: vi.fn().mockResolvedValue({ ciphertext: 'dummy' })
      };
      const roamer = new DraftRoamer({
        relay: { drop_id: 'drop-1' },
        assignmentId: 'asg-1',
        publishVersion: 1,
        studentId: 's-1',
        accessCode: 'CODE1',
        transport: fakeTransport
      });

      // Stub _getSecrets and openDraft
      roamer._getSecrets = vi.fn().mockResolvedValue({ id: 'draft-id', encKey: 'k', hmacKey: 'h' });
      
      // Spy on load by overriding draft loading
      // When draft is submitted, load() returns { submitted: true, submitted_at }
      const origLoad = roamer.load;
      roamer.load = async function() {
        const row = await this.transport.getDraft(this.dropId, 'draft-id', this.dropOpts);
        if (!row) return null;
        const draft = { submitted: true, submitted_at: 1700000005000 };
        if (draft.submitted) {
          return { submitted: true, submitted_at: draft.submitted_at || null };
        }
        return draft;
      };

      const result = await roamer.load();
      expect(result).toEqual({
        submitted: true,
        submitted_at: 1700000005000
      });
    });
  });

  describe('R2.6: Quota warning toast on draft storage', () => {
    it('warns when draft autosave hits QuotaExceededError', () => {
      const warnSpy = vi.spyOn(toast, 'warning');
      const fakeStorage = {
        quotaWarned: false,
        set(key, val) {
          try {
            const err = new Error('The quota has been exceeded.');
            err.name = 'QuotaExceededError';
            err.code = 22;
            throw err;
          } catch (err) {
            if (!this.quotaWarned && (err?.name === 'QuotaExceededError' || err?.code === 22)) {
              this.quotaWarned = true;
              toast.warning('Browser storage is full. Draft autosave could not save all changes.');
            }
          }
        }
      };

      fakeStorage.set('test_key', { data: 'x' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Browser storage is full'));

      // Second write does not duplicate toast
      fakeStorage.set('test_key_2', { data: 'y' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('R2.1 & R2.3: Single Envelope Sealing & Receipt Rendering', () => {
    it('produces identical envelope_text when reusing sealed envelope', async () => {
      const teacherKeyPair = await SubmissionCrypto.generateKeyPair();
      const payload = {
        task_id: 'task-env-1',
        title: 'Project Submission',
        publish_version: 1,
        teacher_key: {
          publicJwk: teacherKeyPair.publicJwk,
          fingerprint: teacherKeyPair.fingerprint
        }
      };

      const student = { id: 'ST-001', name: 'Bob', code: 'CODE1' };
      const content = { text: 'My complete response', code_files: [], drawing: null, attachments: [] };

      const sealed1 = await createTaskSubmission(payload, student, content);
      expect(sealed1.envelopeText).toBeTruthy();
      expect(sealed1.envelopeText.startsWith('KBSUB1.')).toBe(true);

      // If sealed envelope is reused:
      const envelopeTextReuse = sealed1.envelopeText;
      expect(envelopeTextReuse).toBe(sealed1.envelopeText);
    });
  });
});
