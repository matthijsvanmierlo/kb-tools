/**
 * Programmatic notification dispatcher utilizing Shoelace <sl-alert>
 */
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
    messageSpan.innerHTML = message;
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
}

export const toast = ToastNotifier;
export default toast;
