/**
 * RoleMode - Dual Role Switcher (KB-ROLE-001)
 *
 * Manages the top-level user mode: 'teacher' vs 'student'.
 * Allows seamless 1-click toggling between Teacher View and Student View,
 * tailoring the primary navigation, quick actions, and default views without
 * restricting users who are teachers in one context and students in another.
 */

const STORAGE_KEY = 'kb_role_mode_v1';
export const VALID_ROLES = ['teacher', 'student'];

export class RoleMode {
  /**
   * Check if user has explicitly chosen a role.
   * @returns {boolean}
   */
  static hasChosen() {
    try {
      if (typeof localStorage !== 'undefined') {
        const val = localStorage.getItem(STORAGE_KEY);
        return val === 'teacher' || val === 'student';
      }
    } catch (_) {}
    return false;
  }

  /**
   * Get current role mode ('teacher' | 'student'). Defaults to 'teacher'.
   * @returns {'teacher'|'student'}
   */
  static get() {
    try {
      if (typeof localStorage !== 'undefined') {
        const val = localStorage.getItem(STORAGE_KEY);
        if (val === 'student') return 'student';
      }
    } catch (_) {}
    return 'teacher';
  }

  /**
   * Set the active role mode and update DOM dataset and event listeners.
   * @param {'teacher'|'student'} mode
   * @returns {'teacher'|'student'}
   */
  static set(mode) {
    const next = mode === 'student' ? 'student' : 'teacher';
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, next);
      }
    } catch (_) {}

    this.applyToDom(next);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('kb-role-mode-changed', { detail: { mode: next } }));
    }

    return next;
  }

  /**
   * Toggle between 'teacher' and 'student'.
   * @returns {'teacher'|'student'}
   */
  static toggle() {
    const current = this.get();
    const next = current === 'teacher' ? 'student' : 'teacher';
    return this.set(next);
  }

  /**
   * Sync DOM body dataset and active elements with the active role mode.
   * @param {'teacher'|'student'} [mode]
   */
  static applyToDom(mode) {
    const active = mode || this.get();
    if (typeof document !== 'undefined' && document.body) {
      document.body.dataset.roleMode = active;
      if (active === 'student') {
        document.body.dataset.mode = 'student';
      } else {
        delete document.body.dataset.mode;
      }
    }
  }

  /**
   * Initialize role mode on app launch.
   */
  static init() {
    this.applyToDom();
  }
}
