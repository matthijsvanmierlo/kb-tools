import { Sanitizer } from '../core/sanitizer.js';

if (typeof Element !== 'undefined' && typeof Element.prototype.getAnimations !== 'function') {
  Element.prototype.getAnimations = () => [];
}
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = () => ({
    finished: Promise.resolve(),
    cancel: () => {},
    play: () => {},
    pause: () => {},
    addEventListener: () => {},
    removeEventListener: () => {}
  });
}
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = () => ({ matches: false, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {} });
}

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
        if (input && typeof input.select === 'function') input.select();
      }, 50);
    });
  }
}

export class AlertDialog {
  /**
   * Accessible replacement for window.alert()
   * @param {object} options
   * @param {string} [options.title='Notice']
   * @param {string} [options.message='']
   * @param {string} [options.okText='OK']
   * @returns {Promise<void>}
   */
  static show({ title = 'Notice', message = '', okText = 'OK' } = {}) {
    return new Promise((resolve) => {
      if (typeof document === 'undefined') {
        resolve();
        return;
      }

      const dialog = document.createElement('sl-dialog');
      dialog.label = title;
      dialog.className = 'kb-alert-dialog';
      dialog.innerHTML = `
        <div class="py-2 text-slate-700 text-sm leading-relaxed">${Sanitizer.sanitize(message)}</div>
        <div slot="footer" class="flex justify-end gap-2">
          <sl-button variant="primary" id="kb-dialog-ok">${Sanitizer.escapeHTML(okText)}</sl-button>
        </div>
      `;
      document.body.appendChild(dialog);

      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        dialog.hide?.();
        setTimeout(() => dialog.remove(), 200);
        resolve();
      };
      const okBtn = dialog.querySelector('#kb-dialog-ok');
      okBtn?.addEventListener('click', cleanup);
      dialog.addEventListener('sl-request-close', (e) => {
        if (e.target === dialog) cleanup();
      });
      dialog.addEventListener('sl-after-hide', (e) => {
        if (e.target === dialog) cleanup();
      });
      dialog.show?.();
      setTimeout(() => okBtn?.focus(), 50);
    });
  }
}

/**
 * General-purpose modal returning a Promise. Generalizes the `modal()` helper in
 * components/code-exchange.js and adds: a full-screen sheet on phones (`.kb-dialog-sheet`),
 * focus return to the opener, a dirty-guard ("Discard changes?"), a single `sl-after-hide`
 * listener, and `data-persist-route` support.
 *
 * Resolves to `{ value, dialog }` for the action that closed it (the dialog element is detached
 * but still readable so callers can pull form values), or `null` when dismissed (ESC, overlay,
 * X button, or an action marked `dismiss: true`).
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string|Node} [options.body] HTML string (caller escapes interpolated values) or a Node
 * @param {Array<{value:string,label:string,variant?:string,dismiss?:boolean,validate?:(dialog:HTMLElement)=>boolean|Promise<boolean>}>} [options.actions]
 *   An action's `validate` may return false to keep the dialog open.
 * @param {string} [options.width='560px']
 * @param {() => boolean} [options.dismissGuard] Return true when there are unsaved changes
 * @param {boolean} [options.persistRoute=false] Keep the dialog open across route changes
 * @param {(dialog:HTMLElement)=>void} [options.onReady] Called after the dialog is attached, before show()
 * @param {string} [options.className]
 * @returns {Promise<{value:string,dialog:HTMLElement}|null>}
 */
export function kbModal({
  title = '',
  body = '',
  actions = [],
  width = '560px',
  dismissGuard = null,
  persistRoute = false,
  onReady = null,
  className = ''
} = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }

    const opener = document.activeElement;
    const dialog = document.createElement('sl-dialog');
    dialog.label = title;
    dialog.className = `kb-dialog-sheet ${className}`.trim();
    dialog.style.setProperty('--width', `min(${width}, 96vw)`);
    if (persistRoute) dialog.dataset.persistRoute = 'true';

    if (typeof body === 'string') {
      dialog.innerHTML = body;
    } else if (body) {
      dialog.appendChild(body);
    }

    if (actions.length) {
      const footer = document.createElement('div');
      footer.slot = 'footer';
      footer.className = 'flex flex-wrap justify-end gap-2';
      for (const action of actions) {
        const btn = document.createElement('sl-button');
        btn.dataset.kbAction = action.value;
        btn.setAttribute('variant', action.variant || 'default');
        btn.textContent = action.label;
        footer.appendChild(btn);
      }
      dialog.appendChild(footer);
    }

    let result = null;
    let closing = false;

    const confirmDiscard = async () => {
      if (typeof dismissGuard !== 'function' || !dismissGuard()) return true;
      return ConfirmDialog.show({
        title: 'Discard changes?',
        message: 'You have unsaved changes. Close without saving?',
        confirmText: 'Discard',
        cancelText: 'Keep editing',
        variant: 'danger'
      });
    };

    const close = (value) => {
      if (closing) return;
      closing = true;
      result = value === null ? null : { value, dialog };
      dialog.hide?.();
    };

    dialog.addEventListener('click', async (e) => {
      const btn = e.target.closest?.('[data-kb-action]');
      if (!btn || !dialog.contains(btn) || closing) return;
      const action = actions.find(a => a.value === btn.dataset.kbAction);
      if (!action) return;
      if (action.dismiss) {
        if (await confirmDiscard()) close(null);
        return;
      }
      if (typeof action.validate === 'function' && (await action.validate(dialog)) === false) return;
      close(action.value);
    });

    dialog.addEventListener('sl-request-close', async (e) => {
      if (e.target !== dialog || closing) return;
      // Always take over closing so the guard can intervene
      e.preventDefault();
      if (await confirmDiscard()) close(null);
    });

    // The one and only teardown path
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target !== dialog) return;
      dialog.remove();
      try { if (opener && opener.isConnected) opener.focus?.(); } catch (_) {}
      resolve(result);
    });

    document.body.appendChild(dialog);
    onReady?.(dialog);
    dialog.show?.();
  });
}
