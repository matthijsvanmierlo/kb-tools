import { storage } from './storage.js';
import { toCSV } from './csv.js';
import { Sanitizer } from './sanitizer.js';

/**
 * Access codes - KB-CORE-007
 *
 * Two kinds of code exist and must never be confused:
 *  - CLASS code (8 chars, shown ABCD-EFGH): identifies a class. Students type it to find the class
 *    feed on the relay. It is shared with the whole class and is NOT a secret between classmates.
 *  - PERSONAL code (10 chars, shown ABCDE-FGHIJ): one per student. It unlocks the student's encrypted
 *    grade report, signs their submissions (see submission-crypto.js) and finds their roster seat.
 *
 * Both use the Crockford base32 alphabet (no I, L, O or U), drawn with rejection sampling so every
 * symbol is equally likely. Input is forgiving: spaces, dashes and any letter case are accepted.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CLASS_CODE_LENGTH = 8;
export const PERSONAL_CODE_LENGTH = 10;

/** Uniform random index in [0, n) using rejection sampling (no modulo bias). */
function randomIndexes(count, n) {
  const out = [];
  const limit = Math.floor(256 / n) * n; // bytes >= limit are rejected
  while (out.length < count) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.max(16, (count - out.length) * 2)));
    for (let i = 0; i < bytes.length && out.length < count; i++) {
      if (bytes[i] < limit) out.push(bytes[i] % n);
    }
  }
  return out;
}

/** Raw (ungrouped) random code of `length` symbols */
export function randomCodeSymbols(length) {
  return randomIndexes(length, CODE_ALPHABET.length).map(i => CODE_ALPHABET[i]).join('');
}

export function groupCode(normalized) {
  const n = String(normalized || '');
  if (n.length === CLASS_CODE_LENGTH) return `${n.slice(0, 4)}-${n.slice(4)}`;
  if (n.length === PERSONAL_CODE_LENGTH) return `${n.slice(0, 5)}-${n.slice(5)}`;
  return n.length > 4 ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
}

/** Generate a grouped code. Default length is a personal code. */
export function generateAccessCode(length = PERSONAL_CODE_LENGTH) {
  return groupCode(randomCodeSymbols(length));
}

export function generateClassCode() {
  return generateAccessCode(CLASS_CODE_LENGTH);
}

export function generatePersonalCode() {
  return generateAccessCode(PERSONAL_CODE_LENGTH);
}

/** Uppercase and strip everything but letters and digits: " abcd-efgh " -> "ABCDEFGH" */
export function normalizeAccessCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Map look-alike glyphs to Crockford symbols (O->0, I/L->1) for a forgiving second lookup */
export function crockfordAlias(code) {
  return normalizeAccessCode(code).replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Candidate normalized forms to try, in order: as typed, then with look-alike glyphs fixed */
export function codeCandidates(code) {
  const a = normalizeAccessCode(code);
  const b = crockfordAlias(code);
  return a === b ? (a ? [a] : []) : [a, b];
}

export function formatAccessCode(code) {
  return groupCode(normalizeAccessCode(code));
}

/** Codes shorter than this are rejected when a teacher sets or imports one manually */
export const MIN_ACCESS_CODE_LENGTH = 6;
export const MAX_ACCESS_CODE_LENGTH = 32;

/**
 * One validation rule for every code that did not come from the generator (manual entry and roster
 * import): letters and digits only once separators are removed, at least MIN, at most MAX characters.
 * @returns {{ ok: boolean, code: string, reason?: string }} code is the normalized form when ok
 */
export function validateAccessCode(code) {
  const raw = String(code ?? '').trim();
  if (/[^A-Za-z0-9\s-]/.test(raw)) {
    return { ok: false, code: '', reason: 'Codes can only contain letters, digits, spaces and dashes.' };
  }
  const normalized = normalizeAccessCode(raw);
  if (normalized.length < MIN_ACCESS_CODE_LENGTH) {
    return { ok: false, code: '', reason: `Access codes need at least ${MIN_ACCESS_CODE_LENGTH} letters or digits.` };
  }
  if (normalized.length > MAX_ACCESS_CODE_LENGTH) {
    return { ok: false, code: '', reason: `Access codes can have at most ${MAX_ACCESS_CODE_LENGTH} letters or digits.` };
  }
  return { ok: true, code: normalized };
}

export class AccessCodes {
  /** Personal code by default; pass CLASS_CODE_LENGTH for a class code */
  static generateCode(length = PERSONAL_CODE_LENGTH) {
    return generateAccessCode(length);
  }

  static generateClassCode() {
    return generateClassCode();
  }

  static generatePersonalCode() {
    return generatePersonalCode();
  }

  /**
   * The secret that protects a student's grade report and feedback links: their access code.
   * Student IDs are never used as a fallback (classmates often know them); call ensureForStudent first.
   */
  static reportPassphrase(student) {
    if (!student?.access_code) throw new Error('NO_ACCESS_CODE');
    return normalizeAccessCode(student.access_code);
  }

  /**
   * Give a student a code if they have none, so a private link can be made for them.
   * @returns {Promise<string|null>} the newly created code, or null if they already had one
   */
  static async ensureForStudent(student) {
    if (student?.access_code) return null;
    if (!student?.id) throw new Error('NO_ACCESS_CODE');
    await this.regenerate(student);
    return student.access_code;
  }

  /** Make sure every student in a course has a code; returns the updated students */
  static async ensureForCourse(courseId) {
    const table = storage.table('gradebook_students');
    const students = await table.where('course_id').equals(courseId).toArray();
    const updated = [];
    for (const s of students) {
      if (!s.access_code) {
        s.access_code = generateAccessCode();
        s.access_code_updated_at = new Date().toISOString();
        await table.put(s);
        updated.push(s);
      }
    }
    return students;
  }

  static async regenerate(student) {
    const now = new Date().toISOString();
    if (student.access_code) {
      student.previous_access_codes = Array.isArray(student.previous_access_codes) ? [...student.previous_access_codes] : [];
      student.previous_access_codes.unshift({ code: student.access_code, retired_at: now });
      if (student.previous_access_codes.length > 5) student.previous_access_codes.length = 5;
    }
    student.access_code = generateAccessCode();
    student.access_code_updated_at = now;
    await storage.table('gradebook_students').put(student);
    return student;
  }

  static async setCustom(student, code) {
    const check = validateAccessCode(code);
    if (!check.ok) throw new Error(check.reason);
    const normalized = check.code;
    const now = new Date().toISOString();
    if (student.access_code && normalizeAccessCode(student.access_code) !== normalized) {
      student.previous_access_codes = Array.isArray(student.previous_access_codes) ? [...student.previous_access_codes] : [];
      student.previous_access_codes.unshift({ code: student.access_code, retired_at: now });
      if (student.previous_access_codes.length > 5) student.previous_access_codes.length = 5;
    }
    student.access_code = formatAccessCode(normalized);
    student.access_code_updated_at = now;
    await storage.table('gradebook_students').put(student);
    return student;
  }

  /**
   * Build a direct setup link that auto-populates the student's keychain.
   * `code` is always the CLASS code and `scode` the student's PERSONAL code; neither falls back to the other.
   * @param {object} student
   * @param {object} course
   * @param {string} [baseUrl]
   * @param {{ relay?: string }} [opts] relay URL students should sync through (carried in the link/QR)
   */
  static createOnboardingPassUrl(student, course, baseUrl = (typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : ''), opts = {}) {
    const relay = opts.relay || course?.relay_url || '';
    const params = new URLSearchParams({
      sid: student.student_id || '',
      sname: student.full_name || '',
      code: course?.access_code || '',
      scode: student.access_code || '',
      cid: course?.id || '',
      cname: course?.name || '',
      csec: course?.section || ''
    });
    if (relay) params.set('relay', relay);
    return `${baseUrl}#/student/courses?${params.toString()}`;
  }

  /** CSV of roster codes for printing or mail-merge */
  static toCSV(students, course, baseUrl = '', opts = {}) {
    const rows = students.map(s => ({
      Class: course?.name || '',
      Section: course?.section || '',
      'Class Code': course?.access_code ? formatAccessCode(course.access_code) : '',
      'Student Name': s.full_name || '',
      'Student ID': s.student_id || '',
      'Access Code': s.access_code ? formatAccessCode(s.access_code) : '',
      'Onboarding Link': AccessCodes.createOnboardingPassUrl(s, course, baseUrl, opts)
    }));
    return toCSV(rows, ['Class', 'Section', 'Class Code', 'Student Name', 'Student ID', 'Access Code', 'Onboarding Link']);
  }

  /** Resolve the relay URL slips and QR codes should carry (course override, then teacher relay) */
  static async resolveSlipRelay(course) {
    if (course?.relay_url) return course.relay_url;
    try {
      const { getTransport, getStudentRelayUrl } = await import('./transport.js');
      const transport = await getTransport().catch(() => null);
      return transport?.baseUrl || getStudentRelayUrl() || '';
    } catch (_) {
      return '';
    }
  }

  /**
   * Print cut-out slips for students. Each slip carries the class code, the personal code, the relay
   * (inside the setup link) and a QR code of that link, so a student can join with one scan.
   */
  static async printSlips(students = [], course = {}) {
    if (typeof window === 'undefined') return;
    const w = window.open('', '_blank');
    if (!w) {
      const { toast } = await import('../utils/toast.js');
      toast.warning('Allow pop-ups to print code slips.');
      return;
    }
    const relay = await AccessCodes.resolveSlipRelay(course);
    const { QRCode } = await import('./qrcode.js');
    const esc = v => Sanitizer.escapeHTML(v);
    const classCode = course?.access_code ? formatAccessCode(course.access_code) : '';
    const slips = students.filter(s => s.access_code).map(s => {
      const link = AccessCodes.createOnboardingPassUrl(s, course, undefined, { relay });
      const qr = QRCode.generateSVG(link, { size: 256, margin: 2 });
      return `
      <div class="slip">
        <div class="slip-main">
          <div class="cls">${esc(course?.name || 'Class')}${course?.section ? ` · ${esc(course.section)}` : ''}</div>
          <div class="name">${esc(s.full_name || '')}</div>
          <div class="id">Student ID: ${esc(s.student_id || '')}</div>
          ${classCode ? `<div class="lbl">Class code</div><div class="ccode">${esc(classCode)}</div>` : ''}
          <div class="lbl">Your personal code (keep it private)</div>
          <div class="code">${esc(formatAccessCode(s.access_code))}</div>
          ${relay ? `<div class="relay">Syncs through ${esc(relay.replace(/^https?:\/\//, ''))}</div>` : ''}
        </div>
        <div class="slip-qr">${qr}<div class="qr-hint">Scan to join</div></div>
        <div class="setup-url">Setup link: <span class="url-text">${esc(link)}</span></div>
        <div class="hint">Keep your personal code private. You need it to view your grades and hand in assignments.</div>
      </div>
    `;
    }).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Access codes — ${esc(course?.name || 'Class')}</title>
      <style>
        body { font-family: system-ui, sans-serif; margin: 24px; color: #0f172a; }
        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
        .slip { border: 1px dashed #94a3b8; border-radius: 10px; padding: 14px; break-inside: avoid; display: grid; grid-template-columns: 1fr 96px; gap: 8px; }
        .slip-qr svg { width: 96px; height: 96px; }
        .qr-hint { font-size: 9px; color: #64748b; text-align: center; }
        .cls { font-size: 11px; color: #64748b; }
        .name { font-weight: 700; font-size: 16px; margin-top: 4px; }
        .id { font-size: 12px; color: #475569; }
        .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: #64748b; margin-top: 6px; }
        .ccode { font-family: ui-monospace, monospace; font-size: 15px; letter-spacing: .1em; font-weight: 700; }
        .code { font-family: ui-monospace, monospace; font-size: 20px; letter-spacing: .1em; margin: 2px 0 6px; font-weight: 700; }
        .relay { font-size: 10px; color: #475569; }
        .setup-url, .hint { grid-column: 1 / -1; }
        .setup-url { font-size: 8px; color: #2563eb; margin-bottom: 4px; word-break: break-all; }
        .hint { font-size: 10px; color: #64748b; }
      </style>
      </head><body><div class="grid">${slips}</div><script>window.onload=()=>window.print()<\/script></body></html>`);
    w.document.close();
  }
}

export default AccessCodes;
