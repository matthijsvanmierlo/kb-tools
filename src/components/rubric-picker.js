import { storage } from '../core/storage.js';
import { Sanitizer } from '../core/sanitizer.js';
import { RubricDesigner } from '../modules/gradebook/rubric-builder.js';

const esc = (s) => Sanitizer.escapeHTML(s ?? '');

/**
 * Reusable <kb-rubric-picker> Web Component (WS6)
 *
 * Allows teachers to select a rubric for any graded assignment, quiz, or task,
 * create a new rubric on the fly with the modal designer, or edit the currently
 * selected rubric directly without leaving the parent editor.
 */
export class KbRubricPicker extends HTMLElement {
  static get observedAttributes() {
    return ['course-id', 'value', 'disabled', 'placeholder'];
  }

  constructor() {
    super();
    this._courseId = null;
    this._value = '';
    this._disabled = false;
    this._placeholder = 'Select a rubric...';
    this._rubrics = [];
    this._selectedRubric = null;
    this._isRendering = false;
  }

  connectedCallback() {
    this._upgradeProperty('courseId');
    this._upgradeProperty('value');
    this._upgradeProperty('disabled');
    this._upgradeProperty('placeholder');

    if (!this.innerHTML.trim()) {
      this._buildDOM();
    }
    this.refresh();
  }

  _upgradeProperty(prop) {
    if (Object.prototype.hasOwnProperty.call(this, prop)) {
      const value = this[prop];
      delete this[prop];
      this[prop] = value;
    }
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (name === 'course-id') {
      this._courseId = newVal || null;
      this.refresh();
    } else if (name === 'value') {
      this._value = newVal || '';
      this._syncSelected();
    } else if (name === 'disabled') {
      this._disabled = newVal !== null && newVal !== 'false';
      this._syncDisabled();
    } else if (name === 'placeholder') {
      this._placeholder = newVal || 'Select a rubric...';
      const select = this.querySelector('sl-select');
      if (select) select.placeholder = this._placeholder;
    }
  }

  get value() {
    return this._value;
  }

  set value(v) {
    this._value = v || '';
    if (this._value) {
      this.setAttribute('value', this._value);
    } else {
      this.removeAttribute('value');
    }
    this._syncSelected();
  }

  get courseId() {
    return this._courseId;
  }

  set courseId(id) {
    this._courseId = id || null;
    if (id) {
      this.setAttribute('course-id', id);
    } else {
      this.removeAttribute('course-id');
    }
    this.refresh();
  }

  get disabled() {
    return this._disabled;
  }

  set disabled(d) {
    this._disabled = !!d;
    if (d) {
      this.setAttribute('disabled', '');
    } else {
      this.removeAttribute('disabled');
    }
    this._syncDisabled();
  }

  get rubric() {
    return this._selectedRubric;
  }

  get rubrics() {
    return this._rubrics;
  }

  async refresh() {
    try {
      const all = await storage.table('gradebook_rubrics').toArray().catch(() => []);
      this._rubrics = all.filter(r => !this._courseId || !r.course_id || r.course_id === this._courseId);
    } catch (_) {
      this._rubrics = [];
    }
    this._renderOptions();
    this._syncSelected();
  }

  _buildDOM() {
    this.innerHTML = `
      <div class="kb-rubric-picker-root flex items-center gap-1.5 w-full">
        <sl-select size="small" class="kb-rubric-select flex-1" placeholder="${esc(this._placeholder)}">
          <sl-option value="">(None)</sl-option>
        </sl-select>
        <sl-button size="small" variant="default" class="kb-btn-edit-rubric hidden" title="Edit selected rubric" aria-label="Edit selected rubric">
          <sl-icon name="pencil"></sl-icon>
        </sl-button>
        <sl-button size="small" variant="default" class="kb-btn-new-rubric" title="Create new rubric" aria-label="Create new rubric">
          <sl-icon slot="prefix" name="plus"></sl-icon> New
        </sl-button>
      </div>
    `;

    const select = this.querySelector('.kb-rubric-select');
    const editBtn = this.querySelector('.kb-btn-edit-rubric');
    const newBtn = this.querySelector('.kb-btn-new-rubric');

    select?.addEventListener('sl-change', async () => {
      const selectedVal = select.value;
      if (selectedVal === '__action_new__') {
        select.value = this._value || '';
        await this._handleCreate();
        return;
      }

      this._value = selectedVal || '';
      if (this._value) {
        this.setAttribute('value', this._value);
      } else {
        this.removeAttribute('value');
      }
      this._syncSelected();
      this._dispatchChange();
    });

    editBtn?.addEventListener('click', async () => {
      if (!this._selectedRubric) return;
      await this._handleEdit();
    });

    newBtn?.addEventListener('click', async () => {
      await this._handleCreate();
    });

    this._syncDisabled();
  }

  _renderOptions() {
    const select = this.querySelector('.kb-rubric-select');
    if (!select) return;

    select.innerHTML = `
      <sl-option value="">(None)</sl-option>
      ${this._rubrics.map(r => `
        <sl-option value="${esc(r.id)}">${esc(r.title || 'Untitled Rubric')}</sl-option>
      `).join('')}
      <sl-divider></sl-divider>
      <sl-option value="__action_new__" class="font-semibold text-blue-600">
        <sl-icon slot="prefix" name="plus-lg"></sl-icon> + New Rubric...
      </sl-option>
    `;
  }

  _syncSelected() {
    const select = this.querySelector('.kb-rubric-select');
    const editBtn = this.querySelector('.kb-btn-edit-rubric');

    if (select && select.value !== this._value) {
      select.value = this._value;
    }

    this._selectedRubric = this._rubrics.find(r => r.id === this._value) || null;

    if (editBtn) {
      editBtn.classList.toggle('hidden', !this._selectedRubric);
    }
  }

  _syncDisabled() {
    const select = this.querySelector('.kb-rubric-select');
    const editBtn = this.querySelector('.kb-btn-edit-rubric');
    const newBtn = this.querySelector('.kb-btn-new-rubric');

    if (select) select.disabled = this._disabled;
    if (editBtn) editBtn.disabled = this._disabled;
    if (newBtn) newBtn.disabled = this._disabled;
  }

  async _handleCreate() {
    const newRubric = await RubricDesigner.create({
      courseId: this._courseId,
      initialTitle: 'New Rubric'
    });

    if (newRubric) {
      const existingIdx = this._rubrics.findIndex(r => r.id === newRubric.id);
      if (existingIdx >= 0) {
        this._rubrics[existingIdx] = newRubric;
      } else {
        this._rubrics.push(newRubric);
      }
      this._renderOptions();
      this.value = newRubric.id;
      this._dispatchChange();
    }
  }

  async _handleEdit() {
    if (!this._selectedRubric) return;
    const updated = await RubricDesigner.edit(this._selectedRubric);
    if (updated) {
      const idx = this._rubrics.findIndex(r => r.id === updated.id);
      if (idx >= 0) {
        this._rubrics[idx] = updated;
      } else {
        this._rubrics.push(updated);
      }
      this._selectedRubric = updated;
      this._renderOptions();
      this._syncSelected();
      this._dispatchChange();
    }
  }

  _dispatchChange() {
    this.dispatchEvent(
      new CustomEvent('rubric-change', {
        bubbles: true,
        composed: true,
        detail: {
          rubricId: this._value || null,
          rubric: this._selectedRubric
        }
      })
    );
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kb-rubric-picker')) {
  customElements.define('kb-rubric-picker', KbRubricPicker);
}
