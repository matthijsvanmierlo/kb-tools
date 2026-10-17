import { Sanitizer } from '../../core/sanitizer.js';

/**
 * 2D Virtualized Gradebook Grid (Defensive Engineering)
 * Renders 150 students x 80 assignments (12,000 cells) at 60 FPS using 2D windowing,
 * phantom spacer, pinned sticky headers, and single-input focus delegation.
 */
export class VirtualGradebookGrid {
  /**
   * @param {HTMLElement} mountEl
   * @param {object} config - { students: [], assignments: [], gradesMap: Map, onGradeChange: function }
   */
  constructor(mountEl, config = {}) {
    this.mountEl = mountEl;
    this.students = config.students || [];
    this.assignments = config.assignments || [];
    this.gradesMap = config.gradesMap || new Map(); // key: `${student_id}+${assignment_id}` -> GradeRecord
    this.studentAggregates = config.studentAggregates || new Map(); // student_id -> { score, letter }
    this.onGradeChange = config.onGradeChange || null;

    // Fixed Geometry Constants
    this.ROW_HEIGHT = 40;
    this.HEADER_HEIGHT = 56;
    this.STUDENT_COL_WIDTH = 220;
    this.CELL_WIDTH = 110;
    this.OVERSCAN = 4;

    this.focusedCell = null; // { row, col, studentId, assignmentId }
    this.rafPending = false;
    this.activeInputEl = null;

    this._initDOM();
  }

  _initDOM() {
    this.mountEl.innerHTML = `
      <div id="grid-scroll-viewport" class="relative overflow-auto border border-slate-200 rounded-xl bg-white shadow-sm" style="max-height: 650px; height: 600px;">
        <!-- Phantom Spacer defining total scrollable dimensions -->
        <div id="grid-phantom-spacer" class="relative">
          <!-- Sticky Column Header Row (Top) -->
          <div id="grid-header-row" class="sticky top-0 z-20 flex bg-slate-100 border-b border-slate-200 text-xs font-semibold text-slate-700 select-none" style="height: ${this.HEADER_HEIGHT}px;">
            <div class="sticky left-0 z-30 bg-slate-100 border-r border-slate-200 px-3 flex items-center justify-between" style="width: ${this.STUDENT_COL_WIDTH}px; min-width: ${this.STUDENT_COL_WIDTH}px;">
              <span>Student Roster (${this.students.length})</span>
              <span class="text-[10px] text-slate-400">Total</span>
            </div>
            <div id="grid-header-cells-container" class="relative flex-1" style="height: ${this.HEADER_HEIGHT}px;"></div>
          </div>

          <!-- Sticky Student Name Column (Left) -->
          <div id="grid-pinned-student-col" class="sticky left-0 z-10 select-none" style="width: ${this.STUDENT_COL_WIDTH}px;"></div>

          <!-- Virtual Dynamic Cells Container -->
          <div id="grid-virtual-cells" class="absolute top-[${this.HEADER_HEIGHT}px] left-[${this.STUDENT_COL_WIDTH}px] pointer-events-auto"></div>
        </div>
      </div>
    `;

    this.viewport = this.mountEl.querySelector('#grid-scroll-viewport');
    this.phantomSpacer = this.mountEl.querySelector('#grid-phantom-spacer');
    this.headerCellsContainer = this.mountEl.querySelector('#grid-header-cells-container');
    this.pinnedStudentCol = this.mountEl.querySelector('#grid-pinned-student-col');
    this.virtualCellsContainer = this.mountEl.querySelector('#grid-virtual-cells');

    this.updateDimensions();

    this.viewport.addEventListener('scroll', () => {
      if (!this.rafPending) {
        this.rafPending = true;
        requestAnimationFrame(() => {
          this.renderWindow();
          this.rafPending = false;
        });
      }
    });

    this.renderWindow();
  }

  updateDimensions() {
    const totalWidth = this.STUDENT_COL_WIDTH + this.assignments.length * this.CELL_WIDTH;
    const totalHeight = this.HEADER_HEIGHT + this.students.length * this.ROW_HEIGHT;

    this.phantomSpacer.style.width = `${totalWidth}px`;
    this.phantomSpacer.style.height = `${totalHeight}px`;

    // Render Sticky Assignment Headers
    let headerHtml = '';
    this.assignments.forEach((a, colIdx) => {
      headerHtml += `
        <div class="absolute top-0 flex flex-col justify-center px-2 border-r border-slate-200 overflow-hidden"
             style="left: ${colIdx * this.CELL_WIDTH}px; width: ${this.CELL_WIDTH}px; height: ${this.HEADER_HEIGHT}px;">
          <span class="truncate font-semibold text-slate-800" title="${Sanitizer.escapeHtml(a.title)}">${Sanitizer.escapeHtml(a.title)}</span>
          <span class="text-[10px] text-slate-400 font-mono">Max: ${a.max_score}pt</span>
        </div>
      `;
    });
    this.headerCellsContainer.innerHTML = headerHtml;
  }

  renderWindow() {
    const scrollTop = this.viewport.scrollTop;
    const scrollLeft = this.viewport.scrollLeft;
    const viewportHeight = this.viewport.clientHeight || 600;
    const viewportWidth = this.viewport.clientWidth || 900;

    // 2D Windowing Calculation
    const startRow = Math.max(0, Math.floor(scrollTop / this.ROW_HEIGHT) - this.OVERSCAN);
    const endRow = Math.min(this.students.length - 1, Math.ceil((scrollTop + viewportHeight) / this.ROW_HEIGHT) + this.OVERSCAN);

    const startCol = Math.max(0, Math.floor(scrollLeft / this.CELL_WIDTH) - this.OVERSCAN);
    const endCol = Math.min(this.assignments.length - 1, Math.ceil((scrollLeft + viewportWidth) / this.CELL_WIDTH) + this.OVERSCAN);

    // 1. Render Pinned Left Student Rows for visible rows
    let studentColHtml = '';
    for (let r = startRow; r <= endRow; r++) {
      const student = this.students[r];
      if (!student) continue;
      const agg = this.studentAggregates.get(student.student_id) || { score: null, letter: '-' };

      studentColHtml += `
        <div class="absolute left-0 flex items-center justify-between px-3 bg-white border-b border-r border-slate-200 text-xs hover:bg-slate-50 transition-colors"
             style="top: ${this.HEADER_HEIGHT + r * this.ROW_HEIGHT}px; width: ${this.STUDENT_COL_WIDTH}px; height: ${this.ROW_HEIGHT}px;">
          <div class="truncate mr-2">
            <span class="font-medium text-slate-800 block truncate" title="${Sanitizer.escapeHtml(student.full_name)}">${Sanitizer.escapeHtml(student.full_name)}</span>
            <span class="text-[10px] text-slate-400 font-mono">${Sanitizer.escapeHtml(student.student_id)}</span>
          </div>
          <span class="font-bold text-xs ${agg.score !== null ? 'text-blue-600' : 'text-slate-400'} font-mono">
            ${agg.score !== null ? `${agg.score}%` : '-'}
          </span>
        </div>
      `;
    }
    this.pinnedStudentCol.innerHTML = studentColHtml;

    // 2. Render Virtual Cells in [startRow..endRow] x [startCol..endCol]
    let cellsHtml = '';
    for (let r = startRow; r <= endRow; r++) {
      const student = this.students[r];
      if (!student) continue;

      for (let c = startCol; c <= endCol; c++) {
        const assignment = this.assignments[c];
        if (!assignment) continue;

        const key = `${student.student_id}+${assignment.id}`;
        const record = this.gradesMap.get(key) || { raw_score: null, status: 'submitted' };

        const isFocused = this.focusedCell && this.focusedCell.row === r && this.focusedCell.col === c;

        let displayVal = '';
        let badgeHtml = '';

        if (record.status === 'missing') {
          badgeHtml = '<span class="px-1 py-0.5 rounded text-[9px] font-bold bg-red-100 text-red-700">MISS</span>';
        } else if (record.status === 'exempt') {
          badgeHtml = '<span class="px-1 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-600">EX</span>';
        } else if (record.status === 'late') {
          badgeHtml = '<span class="px-1 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-700">LATE</span>';
          if (record.raw_score !== null) displayVal = String(record.raw_score);
        } else if (record.raw_score !== null) {
          displayVal = String(record.raw_score);
        }

        const xPos = c * this.CELL_WIDTH;
        const yPos = r * this.ROW_HEIGHT;

        cellsHtml += `
          <div data-cell-key="${key}" data-r="${r}" data-c="${c}"
               class="kb-grid-cell ${isFocused ? 'ring-2 ring-blue-500 z-10 bg-white' : 'bg-white'}"
               style="transform: translate3d(${xPos}px, ${yPos}px, 0); width: ${this.CELL_WIDTH}px; height: ${this.ROW_HEIGHT}px;">
            ${isFocused ? '' : `
              <div class="flex items-center gap-1 font-mono text-xs">
                ${badgeHtml}
                <span class="${record.raw_score === null ? 'text-slate-300' : 'text-slate-800 font-semibold'}">${displayVal || '—'}</span>
              </div>
            `}
          </div>
        `;
      }
    }
    this.virtualCellsContainer.innerHTML = cellsHtml;

    // Bind cell click delegation
    this.virtualCellsContainer.querySelectorAll('.kb-grid-cell').forEach(cellEl => {
      cellEl.addEventListener('click', (e) => {
        const r = Number(cellEl.getAttribute('data-r'));
        const c = Number(cellEl.getAttribute('data-c'));
        this.activateCellInput(r, c, cellEl);
      });
    });

    // Re-mount input if focused cell is visible
    if (this.focusedCell) {
      const activeCellEl = this.virtualCellsContainer.querySelector(`[data-r="${this.focusedCell.row}"][data-c="${this.focusedCell.col}"]`);
      if (activeCellEl && !activeCellEl.querySelector('input')) {
        this._mountInputInCell(activeCellEl);
      }
    }
  }

  activateCellInput(row, col, cellEl) {
    const student = this.students[row];
    const assignment = this.assignments[col];
    if (!student || !assignment) return;

    this.focusedCell = { row, col, studentId: student.student_id, assignmentId: assignment.id };
    this._mountInputInCell(cellEl);
  }

  _mountInputInCell(cellEl) {
    const { studentId, assignmentId } = this.focusedCell;
    const key = `${studentId}+${assignmentId}`;
    const record = this.gradesMap.get(key) || { raw_score: null, status: 'submitted' };

    cellEl.innerHTML = `
      <input type="number" step="any" min="0" max="1000" id="active-cell-input"
             class="w-full h-full text-center font-mono text-xs border-0 outline-none focus:ring-0 p-0 m-0 bg-blue-50"
             value="${record.raw_score !== null ? record.raw_score : ''}" />
    `;

    const input = cellEl.querySelector('#active-cell-input');
    this.activeInputEl = input;
    input.focus();
    input.select();

    const commit = () => {
      const val = input.value.trim();
      const numVal = val === '' ? null : Number(val);
      const updatedRecord = {
        ...record,
        student_id: studentId,
        assignment_id: assignmentId,
        raw_score: numVal
      };

      this.gradesMap.set(key, updatedRecord);

      if (typeof this.onGradeChange === 'function') {
        this.onGradeChange(updatedRecord, studentId, assignmentId);
      }

      this.focusedCell = null;
      this.renderWindow();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
        // Move to next row
        if (this.focusedCell && this.focusedCell.row < this.students.length - 1) {
          const nextRow = this.focusedCell.row + 1;
          const col = this.focusedCell.col;
          setTimeout(() => {
            const nextCellEl = this.virtualCellsContainer.querySelector(`[data-r="${nextRow}"][data-c="${col}"]`);
            if (nextCellEl) this.activateCellInput(nextRow, col, nextCellEl);
          }, 50);
        }
      } else if (e.key === 'Escape') {
        this.focusedCell = null;
        this.renderWindow();
      }
    });
  }

  setData(students, assignments, gradesMap, aggregates) {
    this.students = students || [];
    this.assignments = assignments || [];
    this.gradesMap = gradesMap || new Map();
    this.studentAggregates = aggregates || new Map();
    this.updateDimensions();
    this.renderWindow();
  }
}

export default VirtualGradebookGrid;
