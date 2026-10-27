import { Sanitizer } from '../core/sanitizer.js';

/**
 * Accessible Modal Dialog Utilities for KennisBoost Tools
 * Built on Shoelace <sl-dialog> to replace window.confirm() and window.prompt().
 */

export class ConfirmDialog {
  /**
   * Show an accessible confirmation dialog
   * @param {object} options
   * @param {string} [options.title='Confirm Action']
   * @param {string} [options.message='Are you sure you want to proceed?']
   * @param {string} [options.confirmText='Confirm']
   * @param {string} [options.cancelText='Cancel']
   * @param {'primary'|'danger'|'neutral'|'success'|'warning'} [options.variant='primary']
   * @returns {Promise<boolean>}
   */
  static show({
    title = 'Confirm Action',
    message = 'Are you sure you want to proceed?',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    variant = 'primary'
  } = {}) {
    return new Promise((resolve) => {
      if (typeof document === 'undefined') {
        resolve(true);
        return;
      }

      const dialog = document.createElement('sl-dialog');
      dialog.label = title;
      dialog.className = 'kb-confirm-dialog';

      const safeMessage = Sanitizer.sanitize(message);
      const safeConfirmText = Sanitizer.escapeHTML(confirmText);
      const safeCancelText = Sanitizer.escapeHTML(cancelText);

      dialog.innerHTML = `
        <div class="py-2 text-slate-700 text-sm leading-relaxed">
          ${safeMessage}
        </div>
        <div slot="footer" class="flex justify-end gap-2">
          <sl-button variant="default" id="kb-dialog-cancel">${safeCancelText}</sl-button>
          <sl-button variant="${variant}" id="kb-dialog-confirm">${safeConfirmText}</sl-button>
        </div>
      `;

      document.body.appendChild(dialog);

      let resolved = false;
      const cleanup = (result) => {
        if (resolved) return;
        resolved = true;
        dialog.hide?.();
        setTimeout(() => dialog.remove(), 200);
        resolve(result);
      };

      const confirmBtn = dialog.querySelector('#kb-dialog-confirm');
      const cancelBtn = dialog.querySelector('#kb-dialog-cancel');

      confirmBtn?.addEventListener('click', () => cleanup(true));
      cancelBtn?.addEventListener('click', () => cleanup(false));
      dialog.addEventListener('sl-request-close', (e) => {
        if (e.target !== dialog) return;
        cleanup(false);
      });
      dialog.addEventListener('sl-after-hide', (e) => {
        if (e.target !== dialog) return;
        cleanup(false);
      });

      dialog.show?.();
      setTimeout(() => confirmBtn?.focus(), 50);
    });
  }
}

export class PromptDialog {
  /**
   * Show an accessible prompt input dialog
   * @param {object} options
   * @param {string} [options.title='Enter Value']
   * @param {string} [options.message='']
   * @param {string} [options.label='']
   * @param {string} [options.defaultValue='']
   * @param {string} [options.placeholder='']
   * @param {string} [options.confirmText='OK']
   * @param {string} [options.cancelText='Cancel']
   * @returns {Promise<string|null>}
   */
  static show({
    title = 'Enter Value',
    message = '',
    label = '',
    defaultValue = '',
    placeholder = '',
    confirmText = 'OK',
    cancelText = 'Cancel'
  } = {}) {
    return new Promise((resolve) => {
      if (typeof document === 'undefined') {
        resolve(defaultValue);
        return;
      }

      const dialog = document.createElement('sl-dialog');
      dialog.label = title;
      dialog.className = 'kb-prompt-dialog';

      const safeMessage = message ? `<p class="text-xs text-slate-500 mb-3">${Sanitizer.sanitize(message)}</p>` : '';
      const safeLabel = Sanitizer.escapeHTML(label);
      const safePlaceholder = Sanitizer.escapeHTML(placeholder);
      const safeDefault = Sanitizer.escapeHTML(defaultValue);
      const safeConfirmText = Sanitizer.escapeHTML(confirmText);
      const safeCancelText = Sanitizer.escapeHTML(cancelText);

      dialog.innerHTML = `
        <div class="space-y-3 py-1">
          ${safeMessage}
          <sl-input id="kb-prompt-input" label="${safeLabel}" placeholder="${safePlaceholder}" value="${safeDefault}"></sl-input>
        </div>
        <div slot="footer" class="flex justify-end gap-2">
          <sl-button variant="default" id="kb-dialog-cancel">${safeCancelText}</sl-button>
          <sl-button variant="primary" id="kb-dialog-confirm">${safeConfirmText}</sl-button>
        </div>
      `;

      document.body.appendChild(dialog);

      let resolved = false;
      const cleanup = (result) => {
        if (resolved) return;
        resolved = true;
        dialog.hide?.();
        setTimeout(() => dialog.remove(), 200);
        resolve(result);
      };

      const input = dialog.querySelector('#kb-prompt-input');
      const confirmBtn = dialog.querySelector('#kb-dialog-confirm');
      const cancelBtn = dialog.querySelector('#kb-dialog-cancel');

      confirmBtn?.addEventListener('click', () => cleanup(input?.value ?? ''));
      cancelBtn?.addEventListener('click', () => cleanup(null));
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          cleanup(input.value);
        }
      });
      dialog.addEventListener('sl-request-close', (e) => {
        if (e.target !== dialog) return;
        cleanup(null);
      });
      dialog.addEventListener('sl-after-hide', (e) => {
        if (e.target !== dialog) return;
        cleanup(null);
      });

      dialog.show?.();
      setTimeout(() => {
        input?.focus();
        if (input) input.select();
      }, 50);
    });
  }
}
