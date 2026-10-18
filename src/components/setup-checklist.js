import { storage } from '../core/storage.js';

/**
 * Setup Checklist Component - Guided First-Run experience
 */
export class SetupChecklist {
  /**
   * Render the checklist into a container
   * @param {HTMLElement} container
   * @param {object} options
   * @param {Array} options.checklistItems
   * @param {Function} [options.onAction]
   * @param {Function} [options.onDismiss]
   */
  static render(container, { checklistItems = [], onAction, onDismiss } = {}) {
    if (!container || checklistItems.length === 0) return;

    const completedCount = checklistItems.filter(i => i.completed).length;
    const totalCount = checklistItems.length;
    const percent = Math.round((completedCount / totalCount) * 100);

    const el = document.createElement('div');
    el.className = 'bg-white border border-slate-200 rounded-2xl p-5 shadow-xs mb-6';
    el.innerHTML = `
      <div class="flex items-center justify-between pb-3 mb-3 border-b border-slate-100">
        <div>
          <div class="flex items-center gap-2">
            <h3 class="text-base font-bold text-slate-900">Setup Checklist</h3>
            <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">${completedCount}/${totalCount} complete</span>
          </div>
          <p class="text-xs text-slate-500 mt-0.5">Quickly prepare your workspace for the school year.</p>
        </div>
        <button id="btn-dismiss-checklist" type="button" class="text-xs text-slate-400 hover:text-slate-600 transition-colors p-1" title="Dismiss checklist">
          <sl-icon name="x-lg"></sl-icon>
        </button>
      </div>

      <div class="w-full bg-slate-100 rounded-full h-1.5 mb-4 overflow-hidden">
        <div class="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style="width: ${percent}%;"></div>
      </div>

      <div class="space-y-2.5">
        ${checklistItems.map(item => `
          <div class="flex items-center justify-between text-sm py-1">
            <div class="flex items-center gap-2.5">
              <span class="w-5 h-5 rounded-full flex items-center justify-center text-xs ${item.completed ? 'bg-emerald-100 text-emerald-700 font-bold' : 'bg-slate-100 text-slate-400'}">
                <sl-icon name="${item.completed ? 'check-lg' : 'dash'}"></sl-icon>
              </span>
              <span class="${item.completed ? 'text-slate-400 line-through' : 'font-medium text-slate-800'}">${item.label}</span>
            </div>
            ${!item.completed ? `
              <sl-button size="small" variant="default" data-action="${item.id}" data-route="${item.actionRoute}">
                ${item.actionLabel}
              </sl-button>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;

    el.querySelector('#btn-dismiss-checklist')?.addEventListener('click', async () => {
      await storage.setMetadata('setup_checklist_dismissed_at', new Date().toISOString());
      el.remove();
      if (onDismiss) onDismiss();
    });

    el.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.action;
        const route = btn.dataset.route;
        if (onAction) onAction(id, route);
      });
    });

    container.appendChild(el);
  }
}
