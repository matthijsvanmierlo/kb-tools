/**
 * Programmatic notification dispatcher utilizing Shoelace <sl-alert>
 */
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

export class ToastNotifier {
  /**
   * Display a toast notification
   * @param {string} message - Text or HTML message
   * @param {object} options
   * @param {'primary' | 'success' | 'neutral' | 'warning' | 'danger'} [options.variant='primary']
   * @param {string} [options.icon='info-circle']
   * @param {number} [options.duration=3500]
   * @param {boolean} [options.closable=true]
   */
  static notify(message, { variant = 'primary', icon = 'info-circle', duration = 3500, closable = true } = {}) {
    if (typeof document === 'undefined') {
      console.log(`[Toast ${variant.toUpperCase()}]: ${message}`);
      return null;
    }

    const alert = document.createElement('sl-alert');
    alert.variant = variant;
    alert.duration = duration;
    if (closable) alert.setAttribute('closable', '');

    const iconEl = document.createElement('sl-icon');
    iconEl.setAttribute('slot', 'icon');
    iconEl.setAttribute('name', icon);
    alert.appendChild(iconEl);

    const messageSpan = document.createElement('span');
    messageSpan.textContent = message;
    alert.appendChild(messageSpan);

    document.body.appendChild(alert);

    // If Shoelace component is ready, call toast(), else show and auto-remove
    if (typeof alert.toast === 'function') {
      alert.toast();
    } else {
      alert.setAttribute('open', '');
      setTimeout(() => {
        alert.removeAttribute('open');
        setTimeout(() => alert.remove(), 300);
      }, duration);
    }

    alert.addEventListener('sl-after-hide', () => {
      alert.remove();
    });

    return alert;
  }

  static success(msg, duration = 3500) {
    return this.notify(msg, { variant: 'success', icon: 'check2-circle', duration });
  }

  static warning(msg, duration = 6000) {
    return this.notify(msg, { variant: 'warning', icon: 'exclamation-triangle', duration });
  }

  static danger(msg, duration = 8000) {
    return this.notify(msg, { variant: 'danger', icon: 'exclamation-octagon', duration });
  }

  static info(msg, duration = 3500) {
    return this.notify(msg, { variant: 'primary', icon: 'info-circle', duration });
  }

  static action(msg, actionText, onAction, duration = 10000) {
    if (typeof document === 'undefined') {
      console.log(`[Toast ACTION]: ${msg}`);
      return null;
    }

    const alert = document.createElement('sl-alert');
    alert.variant = 'neutral';
    alert.duration = duration;
    alert.setAttribute('closable', '');

    const iconEl = document.createElement('sl-icon');
    iconEl.setAttribute('slot', 'icon');
    iconEl.setAttribute('name', 'info-circle');
    alert.appendChild(iconEl);

    const wrap = document.createElement('div');
    wrap.className = 'flex items-center justify-between gap-3 w-full';

    const messageSpan = document.createElement('span');
    messageSpan.textContent = msg;
    wrap.appendChild(messageSpan);

    if (actionText && typeof onAction === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'px-2 py-0.5 text-xs font-semibold rounded bg-blue-600 text-white hover:bg-blue-700 transition cursor-pointer shrink-0';
      btn.textContent = actionText;
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        alert.remove();
        try {
          await onAction();
        } catch (err) {
          console.error('Toast action failed:', err);
        }
      });
      wrap.appendChild(btn);
    }

    alert.appendChild(wrap);
    document.body.appendChild(alert);

    if (typeof alert.toast === 'function') {
      alert.toast();
    } else {
      alert.setAttribute('open', '');
      setTimeout(() => {
        alert.removeAttribute('open');
        setTimeout(() => alert.remove(), 300);
      }, duration);
    }

    alert.addEventListener('sl-after-hide', () => alert.remove());
    return alert;
  }
}

export const toast = ToastNotifier;
export default toast;
