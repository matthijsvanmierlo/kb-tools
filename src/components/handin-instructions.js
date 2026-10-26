/**
 * HandinInstructions Component (KB-COMP-008)
 * Renders LMS-ready assignment hand-in instructions with a one-click copy button.
 */

import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';

export class HandinInstructions {
  /**
   * Produce the plain-text template per Appendix D.
   *
   * @param {object} params
   * @param {string} params.title
   * @param {string} [params.dueDate]
   * @param {string} params.link
   * @param {string} [params.email]
   * @returns {string}
   */
  static getTemplate({ title, dueDate, link, email, teacherEmail }) {
    const dueStr = dueDate ? `due ${dueDate}` : 'no due date';
    const mail = email || teacherEmail || '';
    const emailClause = mail ? ` or email it to ${mail}` : '';
    return `${title || 'Assessment'} — ${dueStr}
1. Open this link: ${link}
2. Enter your full name, your student ID and the access code you received from me.
3. Answer the questions. Your answers save automatically in your browser.
4. When you finish, click "Download submission file" and upload the .kbsub file here${emailClause}.
   If you cannot upload files, click "Copy submission code" and paste the code as a comment.
Nothing is sent automatically. Your work is encrypted so only I can open it.`;
  }

  /**
   * Render an interactive DOM container for hand-in instructions.
   *
   * @param {object} params
   * @param {object} params.assignment
   * @param {string} params.link
   * @param {string} [params.dueDate]
   * @param {string} [params.teacherEmail]
   * @returns {HTMLElement}
   */
  static render({ assignment, link, dueDate, teacherEmail }) {
    const title = assignment?.title || 'Assessment';
    const due = dueDate || (assignment?.settings?.due_date ? new Date(`${assignment.settings.due_date}T12:00:00`).toLocaleDateString() : '');
    const email = teacherEmail || '';
    const text = this.getTemplate({ title, dueDate: due, link, email });

    const card = document.createElement('div');
    card.className = 'rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3';
    card.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
          <sl-icon name="card-checklist" class="text-amber-600"></sl-icon>
          Hand-in instructions for your LMS
        </span>
        <sl-button size="small" id="btn-copy-handin-text">
          <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy instructions
        </sl-button>
      </div>
      <sl-textarea id="handin-instructions-text" rows="5" readonly class="text-xs font-mono"></sl-textarea>
      <p class="text-[11px] text-slate-500">Paste this text into Google Classroom, Canvas, or Teams alongside your assignment link.</p>
    `;

    const textarea = card.querySelector('#handin-instructions-text');
    textarea.value = text;

    card.querySelector('#btn-copy-handin-text').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success('Hand-in instructions copied to clipboard!');
      } catch (_) {
        toast.warning('Copy failed — please select and copy the text manually.');
      }
    });

    return card;
  }
}

export default HandinInstructions;
