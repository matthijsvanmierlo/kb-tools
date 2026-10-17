import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { getStandards, levelInfo, getMaxLevel } from './grading-scales.js';

/**
 * Parse what a teacher typed into a grade cell.
 * Supports numbers, "M" (missing), "E"/"X" (excused), "L" / "L3" (late, days) and "85L" / "85 L2".
 * @returns {{ kind: 'clear'|'missing'|'exempt'|'late'|'score'|'invalid', score?: number, days?: number }}
 */
export function parseCellEntry(rawVal) {
  const v = String(rawVal ?? '').trim();
  if (v === '' || v === '—' || v === '-') return { kind: 'clear' };
  const lower = v.toLowerCase();
  if (lower === 'm') return { kind: 'missing' };
  if (lower === 'e' || lower === 'x') return { kind: 'exempt' };
  const late = lower.match(/^(\d+(?:\.\d+)?)?\s*l(\d+)?$/);
  if (late) {
    return {
      kind: 'late',
      score: late[1] !== undefined ? parseFloat(late[1]) : undefined,
      days: late[2] !== undefined ? Math.max(1, parseInt(late[2], 10)) : undefined
    };
  }
  const n = parseFloat(v);
  if (!Number.isNaN(n) && /^-?\d*\.?\d+$/.test(v)) return { kind: 'score', score: n };
  return { kind: 'invalid' };
}

/**
 * 2D Virtualized Gradebook Grid (Defensive Engineering)
 * Renders 150 students x 80 assignments (12,000 cells) at 60 FPS using 2D windowing,
 * phantom spacer, pinned sticky headers, crosshair highlighting, spreadsheet keyboard navigation,
 * single-key status shortcuts (M/E/L), 20-step undo/redo stack, and pinned class average footer.
 */
export class VirtualGradebookGrid {
  /**
   * @param {HTMLElement} mountEl
   * @param {object} config
   */
  constructor(mountEl, config = {}) {
    this.mountEl = mountEl;
    this.courseId = config.courseId || null;
    this.students = config.students || [];
    this.assignments = config.assignments || [];
    this.rubrics = config.rubrics || [];
    this.gradesMap = config.gradesMap || new Map(); // key: `${student_id}+${assignment_id}` -> GradeRecord
    this.studentAggregates = config.studentAggregates || new Map(); // student_id -> { score, letter }
    this.onGradeChange = config.onGradeChange || null;
    this.onOpenDetails = config.onOpenDetails || null;
    this.course = config.course || null;
    this.onStudentClick = config.onStudentClick || null;
    this.onAssignmentClick = config.onAssignmentClick || null;

    // Fixed Geometry Constants
    this.ROW_HEIGHT = 40;
    this.HEADER_HEIGHT = 56;
    this.FOOTER_HEIGHT = 44;
    this.STUDENT_COL_WIDTH = 220;
    this.CELL_WIDTH = 120;
    this.MIN_CELL_WIDTH = 120;
    this.MAX_CELL_WIDTH = 180;
    this.OVERSCAN = 4;

    this.focusedCell = null; // { row, col, studentId, assignmentId }
    this.hoveredCell = null; // { row, col }
    this.rafPending = false;
    this.activeInputEl = null;

    // 20-Step Undo/Redo Stack
    this.undoStack = [];
    this.redoStack = [];

    this._initDOM();
  }

  _initDOM() {
    // Layout: header, body and footer are stacked in normal flow inside the scroll viewport.
    // The body is one coordinate space shared by the sticky student column and the virtual
    // cells, so row r is always at top = r * ROW_HEIGHT for both and they stay aligned.
    this.mountEl.innerHTML = `
      <div id="grid-scroll-viewport" class="relative overflow-auto border border-slate-200 rounded-xl bg-white shadow-xs focus:outline-none" tabindex="0" style="max-height: min(640px, calc(100vh - 240px)); width: fit-content; max-width: 100%;">
        <div id="grid-phantom-spacer" class="relative">
          <!-- Sticky Column Header Row (Top) -->
          <div id="grid-header-row" class="sticky top-0 z-20 flex bg-slate-100 border-b border-slate-200 text-xs font-semibold text-slate-700 select-none" style="height: ${this.HEADER_HEIGHT}px;">
            <div class="sticky left-0 z-30 bg-slate-100 border-r border-slate-200 px-4 flex items-center justify-between gap-2" style="width: ${this.STUDENT_COL_WIDTH}px; min-width: ${this.STUDENT_COL_WIDTH}px;">
              <span class="truncate">Students <span class="text-slate-400 font-medium">(<span id="header-roster-count">${this.students.length}</span>)</span></span>
              <span class="text-[10px] uppercase tracking-wider text-slate-400">Overall</span>
            </div>
            <div id="grid-header-cells-container" class="relative flex-1" style="height: ${this.HEADER_HEIGHT}px;"></div>
          </div>

          <!-- Body: pinned student column + virtual cells share this coordinate space -->
          <div id="grid-body" class="relative">
            <div id="grid-pinned-student-col" class="sticky left-0 z-10 h-full select-none" style="width: ${this.STUDENT_COL_WIDTH}px;"></div>
            <div id="grid-virtual-cells" class="absolute top-0 pointer-events-auto" style="left: ${this.STUDENT_COL_WIDTH}px;"></div>
          </div>

          <!-- Pinned Sticky Footer Row: Class Averages -->
          <div id="grid-footer-row" class="sticky bottom-0 z-20 flex bg-slate-100 border-t border-slate-200 text-xs font-semibold text-slate-700 select-none" style="height: ${this.FOOTER_HEIGHT}px;">
            <div class="sticky left-0 z-30 bg-slate-100 border-r border-slate-200 px-4 flex items-center justify-between" style="width: ${this.STUDENT_COL_WIDTH}px; min-width: ${this.STUDENT_COL_WIDTH}px;">
              <span class="font-semibold text-slate-700">Class average</span>
              <span class="text-blue-600 font-bold tabular-nums" id="class-overall-average">—</span>
            </div>
            <div id="grid-footer-cells-container" class="relative flex-1" style="height: ${this.FOOTER_HEIGHT}px;"></div>
          </div>
        </div>
      </div>
    `;

    this.viewport = this.mountEl.querySelector('#grid-scroll-viewport');
    this.phantomSpacer = this.mountEl.querySelector('#grid-phantom-spacer');
    this.headerCellsContainer = this.mountEl.querySelector('#grid-header-cells-container');
    this.pinnedStudentCol = this.mountEl.querySelector('#grid-pinned-student-col');
    this.virtualCellsContainer = this.mountEl.querySelector('#grid-virtual-cells');
    this.footerCellsContainer = this.mountEl.querySelector('#grid-footer-cells-container');
    this.gridBody = this.mountEl.querySelector('#grid-body');

    // Re-fit column widths when the available width changes
    if (typeof ResizeObserver !== 'undefined') {
      let lastWidth = this.mountEl.clientWidth;
      this.resizeObserver = new ResizeObserver(() => {
        const w = this.mountEl.clientWidth;
        if (Math.abs(w - lastWidth) < 2) return;
        lastWidth = w;
        this.updateDimensions();
        this.renderWindow();
      });
      this.resizeObserver.observe(this.mountEl);
    }

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

    // Keyboard shortcuts for Undo/Redo when grid has focus
    this.viewport.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !this.activeInputEl) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            this.redo();
          } else {
            this.undo();
          }
        } else if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          this.redo();
        }
      }
    });

    this.renderWindow();
  }

  updateDimensions() {
    // Stretch columns to use the available width (within sane bounds)
    const available = (this.mountEl.clientWidth || 0) - this.STUDENT_COL_WIDTH - 2;
    const count = this.assignments.length;
    this.CELL_WIDTH = count > 0 && available > 0
      ? Math.max(this.MIN_CELL_WIDTH, Math.min(this.MAX_CELL_WIDTH, Math.floor(available / count)))
      : this.MIN_CELL_WIDTH;

    const totalWidth = this.STUDENT_COL_WIDTH + count * this.CELL_WIDTH;
    const bodyHeight = this.students.length * this.ROW_HEIGHT;

    this.phantomSpacer.style.width = `${totalWidth}px`;
    if (this.gridBody) {
      this.gridBody.style.height = `${bodyHeight}px`;
      this.gridBody.style.width = `${totalWidth}px`;
    }
    const rosterCount = this.mountEl.querySelector('#header-roster-count');
    if (rosterCount) rosterCount.textContent = String(this.students.length);

    // Render Sticky Assignment Headers
    let headerHtml = '';
    this.assignments.forEach((a, colIdx) => {
      const hasRubric = !!a.rubric_id;
      headerHtml += `
        <div class="header-col-cell absolute top-0 flex flex-col justify-center gap-0.5 px-3 border-r border-slate-200 overflow-hidden cursor-pointer hover:bg-slate-200 transition-colors"
             data-col-idx="${colIdx}"
             title="${Sanitizer.escapeHTML(a.title)} (Click to edit assignment)"
             style="left: ${colIdx * this.CELL_WIDTH}px; width: ${this.CELL_WIDTH}px; height: ${this.HEADER_HEIGHT}px;">
          <div class="flex items-center justify-between gap-1">
            <span class="truncate font-semibold text-slate-800">${Sanitizer.escapeHTML(a.title)}</span>
            ${hasRubric ? '<sl-icon name="grid-3x3" class="text-violet-600 text-[10px] flex-shrink-0" title="Graded with a rubric"></sl-icon>' : ''}
          </div>
          <span class="text-[10px] font-medium text-slate-400 tabular-nums truncate">${a.scoring === 'proficiency'
            ? `Proficiency${this._standardCodes(a) ? ` · ${this._standardCodes(a)}` : ''}`
            : `out of ${a.max_score}${this._standardCodes(a) ? ` · ${this._standardCodes(a)}` : ''}`}</span>
        </div>
      `;
    });
    this.headerCellsContainer.innerHTML = headerHtml;

    // Header click binding
    this.headerCellsContainer.querySelectorAll('.header-col-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const idx = Number(cell.getAttribute('data-col-idx'));
        const as = this.assignments[idx];
        if (as && typeof this.onAssignmentClick === 'function') {
          this.onAssignmentClick(as);
        }
      });
    });

    this.renderFooterAverages();
  }

  _standardCodes(assignment) {
    const ids = assignment.standard_ids || [];
    if (!ids.length || !this.course) return '';
    const all = getStandards(this.course);
    const codes = ids.map(id => all.find(s => s.id === id)?.code).filter(Boolean);
    if (codes.length <= 2) return Sanitizer.escapeHTML(codes.join(', '));
    return `${Sanitizer.escapeHTML(codes[0])} +${codes.length - 1}`;
  }

  renderFooterAverages() {
    if (!this.footerCellsContainer) return;

    let overallSum = 0;
    let overallCount = 0;

    let footerHtml = '';
    this.assignments.forEach((a, colIdx) => {
      const scores = [];
      this.students.forEach(s => {
        const key = `${s.student_id}+${a.id}`;
        const rec = this.gradesMap.get(key);
        if (rec && rec.status !== 'exempt' && rec.raw_score !== null) {
          scores.push(Number(rec.raw_score));
        }
      });

      let avgText = '—';
      if (scores.length > 0) {
        const sum = scores.reduce((acc, v) => acc + v, 0);
        const mean = (sum / scores.length).toFixed(1);
        avgText = `${mean}`;

        if (a.max_score > 0) {
          overallSum += (sum / scores.length) / a.max_score;
          overallCount++;
        }
      }

      footerHtml += `
        <div class="absolute top-0 flex items-center justify-center px-2 border-r border-slate-200 tabular-nums text-xs text-slate-600 font-semibold"
             style="left: ${colIdx * this.CELL_WIDTH}px; width: ${this.CELL_WIDTH}px; height: ${this.FOOTER_HEIGHT}px;">
          ${avgText}
        </div>
      `;
    });

    this.footerCellsContainer.innerHTML = footerHtml;

    const overallAvgEl = this.mountEl.querySelector('#class-overall-average');
    if (overallAvgEl) {
      if (overallCount > 0) {
        const pct = Math.round((overallSum / overallCount) * 100);
        overallAvgEl.textContent = `${pct}%`;
      } else {
        overallAvgEl.textContent = '—';
      }
    }
  }

  renderWindow() {
    const scrollTop = this.viewport.scrollTop;
    const scrollLeft = this.viewport.scrollLeft;
    const viewportHeight = this.viewport.clientHeight || 600;
    const viewportWidth = this.viewport.clientWidth || 900;

    // 2D Windowing Calculation
    const bodyScrollTop = Math.max(0, scrollTop - this.HEADER_HEIGHT);
    const startRow = Math.max(0, Math.floor(bodyScrollTop / this.ROW_HEIGHT) - this.OVERSCAN);
    const endRow = Math.min(this.students.length - 1, Math.ceil((bodyScrollTop + viewportHeight) / this.ROW_HEIGHT) + this.OVERSCAN);

    const startCol = Math.max(0, Math.floor(scrollLeft / this.CELL_WIDTH) - this.OVERSCAN);
    const endCol = Math.min(this.assignments.length - 1, Math.ceil((scrollLeft + viewportWidth) / this.CELL_WIDTH) + this.OVERSCAN);

    // 1. Render Pinned Left Student Rows
    let studentColHtml = '';
    for (let r = startRow; r <= endRow; r++) {
      const student = this.students[r];
      if (!student) continue;
      const agg = this.studentAggregates.get(student.student_id) || { score: null, letter: '-' };
      const isRowFocused = this.focusedCell && this.focusedCell.row === r;
      // Pinned column must stay opaque so cells never show through while scrolling sideways
      const zebraBg = r % 2 === 1 ? 'bg-slate-50' : 'bg-white';
      const rowBg = isRowFocused ? 'bg-blue-50' : zebraBg;

      // Color letter grade pill
      let letterPill = 'text-slate-400 bg-slate-100';
      if (agg.letter.startsWith('A')) letterPill = 'text-emerald-700 bg-emerald-100';
      else if (agg.letter.startsWith('B')) letterPill = 'text-blue-700 bg-blue-100';
      else if (agg.letter.startsWith('C')) letterPill = 'text-amber-700 bg-amber-100';
      else if (agg.letter === 'D' || agg.letter === 'F') letterPill = 'text-rose-700 bg-rose-100';

      studentColHtml += `
        <div class="student-pinned-cell absolute left-0 flex items-center justify-between gap-2 px-4 ${rowBg} border-b border-r border-slate-200 text-xs hover:bg-blue-50 transition-colors cursor-pointer select-none"
             data-student-idx="${r}"
             style="top: ${r * this.ROW_HEIGHT}px; width: ${this.STUDENT_COL_WIDTH}px; height: ${this.ROW_HEIGHT}px;">
          <div class="min-w-0 leading-tight">
            <span class="font-medium text-slate-800 block truncate" title="${Sanitizer.escapeHTML(student.full_name)}">${Sanitizer.escapeHTML(student.full_name)}</span>
            <span class="text-[10px] text-slate-400 tabular-nums">${Sanitizer.escapeHTML(student.student_id)}</span>
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0 tabular-nums">
            <span class="font-semibold text-xs ${agg.score !== null || agg.mastery != null ? 'text-slate-800' : 'text-slate-400'}" ${agg.mastery != null ? 'title="Average mastery across standards"' : ''}>
              ${agg.mastery != null ? `${agg.mastery.toFixed(1)}` : agg.score !== null ? `${agg.score}%` : '—'}
            </span>
            <span class="inline-flex items-center justify-center min-w-[26px] px-1 py-0.5 rounded text-[10px] font-bold ${letterPill}">${agg.letter}</span>
          </div>
        </div>
      `;
    }
    this.pinnedStudentCol.innerHTML = studentColHtml;

    // Student pinned cell click binding
    this.pinnedStudentCol.querySelectorAll('.student-pinned-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const idx = Number(cell.getAttribute('data-student-idx'));
        const st = this.students[idx];
        if (st && typeof this.onStudentClick === 'function') {
          this.onStudentClick(st);
        }
      });
    });

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
        const isCrosshairRow = this.focusedCell && this.focusedCell.row === r;
        const isCrosshairCol = this.focusedCell && this.focusedCell.col === c;

        let displayVal = '';
        let badgeHtml = '';

        if (record.status === 'missing') {
          badgeHtml = '<span class="px-1 py-0.5 rounded text-[9px] font-bold bg-rose-100 text-rose-700">MISS</span>';
        } else if (record.status === 'exempt') {
          badgeHtml = '<span class="px-1 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-600">EX</span>';
        } else if (record.status === 'late') {
          const daysLate = record.days_late ? `${record.days_late}d ` : '';
          badgeHtml = `<span class="px-1 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-700">${daysLate}LATE</span>`;
          if (record.raw_score !== null) displayVal = String(record.raw_score);
        } else if (record.raw_score !== null && assignment.scoring === 'proficiency') {
          const lvl = levelInfo(this.course, record.raw_score);
          badgeHtml = `<span class="inline-flex items-center justify-center min-w-[28px] px-1.5 py-0.5 rounded-md text-xs font-bold text-white tabular-nums" style="background-color:${lvl?.color || '#64748b'}" title="${Sanitizer.escapeHTML(lvl?.label || '')}">${record.raw_score}</span>`;
        } else if (record.raw_score !== null) {
          displayVal = String(record.raw_score);
          // Extra credit badge if score exceeds max score
          if (assignment.max_score && record.raw_score > assignment.max_score) {
            badgeHtml = '<span class="px-1 py-0.5 rounded text-[9px] font-bold bg-emerald-100 text-emerald-700">EC</span>';
          }
        }

        // Cell background calculation (zebra + crosshair)
        let cellBg = r % 2 === 1 ? 'bg-slate-50' : 'bg-white';
        if (isCrosshairRow || isCrosshairCol) cellBg = 'bg-blue-50/60';
        if (isFocused) cellBg = 'bg-white';

        const xPos = c * this.CELL_WIDTH;
        const yPos = r * this.ROW_HEIGHT;

        const hasRubric = !!assignment.rubric_id;
        const hasRubricEval = !!record.rubric_eval && Object.keys(record.rubric_eval).length > 0;
        const hasFeedback = !!(record.feedback || (record.rubric_comments && Object.keys(record.rubric_comments).length) || (record.standard_comments && Object.keys(record.standard_comments).length));

        cellsHtml += `
          <div data-cell-key="${key}" data-r="${r}" data-c="${c}"
               class="kb-grid-cell absolute border-b border-r border-slate-200 flex items-center justify-center cursor-pointer select-none transition-colors ${cellBg} ${isFocused ? 'ring-2 ring-blue-500 z-10' : ''}"
               style="transform: translate3d(${xPos}px, ${yPos}px, 0); width: ${this.CELL_WIDTH}px; height: ${this.ROW_HEIGHT}px;">
            ${isFocused ? '' : `
              ${hasFeedback ? '<span class="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-blue-500" title="Has feedback"></span>' : ''}
              <div class="flex items-center gap-1.5 tabular-nums text-sm w-full px-2 justify-center">
                ${badgeHtml}
                <span class="${record.raw_score === null && !badgeHtml ? 'text-slate-300' : 'text-slate-800 font-semibold'}">${displayVal || (badgeHtml ? '' : '—')}</span>
                ${hasRubric ? `<sl-icon name="grid-3x3" class="text-[10px] ${hasRubricEval ? 'text-violet-600' : 'text-slate-300'} ml-0.5" title="${hasRubricEval ? 'Scored with rubric' : 'Rubric not scored yet'}"></sl-icon>` : ''}
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
        if (e.target.closest('.kb-cell-details-btn')) return;
        // Cells re-render between clicks, so native dblclick is unreliable: detect it ourselves
        const now = Date.now();
        const last = this._lastCellClick;
        this._lastCellClick = { r, c, t: now };
        if (last && last.r === r && last.c === c && now - last.t < 400 && typeof this.onOpenDetails === 'function') {
          this._lastCellClick = null;
          this.openDetails(r, c);
          return;
        }
        if (this.focusedCell && this.focusedCell.row === r && this.focusedCell.col === c && this.activeInputEl) return;
        this.activateCellInput(r, c, cellEl);
      });

      // Right-click or double-click opens the full grade details drawer
      const openDetails = (e) => {
        if (typeof this.onOpenDetails !== 'function') return;
        e.preventDefault();
        this.openDetails(Number(cellEl.getAttribute('data-r')), Number(cellEl.getAttribute('data-c')));
      };
      cellEl.addEventListener('contextmenu', openDetails);
    });

    // Re-mount input if focused cell is visible
    if (this.focusedCell) {
      const activeCellEl = this.virtualCellsContainer.querySelector(`[data-r="${this.focusedCell.row}"][data-c="${this.focusedCell.col}"]`);
      if (activeCellEl && !activeCellEl.querySelector('input')) {
        this._mountInputInCell(activeCellEl);
      }
    }
  }

  /** Open the grade details drawer for a cell (commits any in-progress edit first) */
  openDetails(row, col) {
    const student = this.students[row];
    const assignment = this.assignments[col];
    if (!student || !assignment || typeof this.onOpenDetails !== 'function') return;
    if (this.activeInputEl) {
      this.activeInputEl.blur();
    }
    const key = `${student.student_id}+${assignment.id}`;
    const rec = this.gradesMap.get(key) || { raw_score: null, status: 'submitted' };
    this.onOpenDetails(student, assignment, rec, { row, col });
  }

  activateCellInput(row, col, cellEl) {
    if (row < 0 || row >= this.students.length || col < 0 || col >= this.assignments.length) return;
    const student = this.students[row];
    const assignment = this.assignments[col];
    if (!student || !assignment) return;

    this.focusedCell = { row, col, studentId: student.student_id, assignmentId: assignment.id };

    if (!cellEl) {
      cellEl = this.virtualCellsContainer.querySelector(`[data-r="${row}"][data-c="${col}"]`);
    }

    if (cellEl) {
      this._mountInputInCell(cellEl);
    } else {
      // Scroll into view if virtualized out
      const targetTop = row * this.ROW_HEIGHT;
      const targetLeft = col * this.CELL_WIDTH;
      this.viewport.scrollTop = targetTop;
      this.viewport.scrollLeft = targetLeft;
      requestAnimationFrame(() => {
        this.renderWindow();
        const el = this.virtualCellsContainer.querySelector(`[data-r="${row}"][data-c="${col}"]`);
        if (el) this._mountInputInCell(el);
      });
    }
  }

  _mountInputInCell(cellEl) {
    const { row, col, studentId, assignmentId } = this.focusedCell;
    const key = `${studentId}+${assignmentId}`;
    const record = this.gradesMap.get(key) || { raw_score: null, status: 'submitted' };
    const assignment = this.assignments[col];

    const lateSuffix = record.status === 'late' ? `L${record.days_late && record.days_late > 1 ? record.days_late : ''}` : '';
    const initialValue = record.raw_score !== null && record.raw_score !== undefined
      ? `${record.raw_score}${lateSuffix}`
      : (record.status === 'missing' ? 'M' : record.status === 'exempt' ? 'E' : lateSuffix);
    const maxHint = assignment?.scoring === 'proficiency' ? `0–${getMaxLevel(this.course)}` : `0–${assignment?.max_score ?? ''}`;

    cellEl.innerHTML = `
      <input type="text" id="active-cell-input" aria-label="Score ${maxHint}. M missing, L late, E excused. Ctrl+Enter for details."
             class="w-full h-full text-center tabular-nums text-sm border-0 outline-none focus:ring-0 p-0 pr-6 m-0 bg-blue-50 font-semibold text-slate-900"
             value="${initialValue}" />
      ${typeof this.onOpenDetails === 'function' ? `
        <button type="button" class="kb-cell-details-btn absolute right-0.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md text-blue-600 hover:bg-blue-100" tabindex="-1" title="Details, rubric & feedback (Ctrl+Enter)" aria-label="Open grade details">
          <sl-icon name="arrows-angle-expand" class="text-xs"></sl-icon>
        </button>` : ''}
    `;
    cellEl.querySelector('.kb-cell-details-btn')?.addEventListener('mousedown', (e) => {
      // mousedown so the input's blur-commit runs first, then the drawer opens
      e.preventDefault();
      const { row: r, col: c } = this.focusedCell || { row, col };
      commitAndNavigate();
      this.openDetails(r, c);
    });

    const input = cellEl.querySelector('#active-cell-input');
    this.activeInputEl = input;
    input.focus();
    input.select();

    let committed = false;

    const commitAndNavigate = (nextRow = null, nextCol = null) => {
      if (committed) return;
      committed = true;

      const rawVal = input.value.trim();
      let updatedStatus = record.status || 'submitted';
      let numVal = record.raw_score;
      let daysLate = record.days_late;

      const entry = parseCellEntry(rawVal);
      const isProficiency = assignment?.scoring === 'proficiency';
      const maxAllowed = isProficiency ? getMaxLevel(this.course) : (assignment?.max_score || 0);

      const checkScore = (parsed) => {
        if (parsed < 0) {
          toast.warning('Negative scores are not allowed. Clamped to 0.');
          return 0;
        }
        if (isProficiency && parsed > maxAllowed) {
          toast.warning(`Proficiency levels go up to ${maxAllowed}.`);
          return maxAllowed;
        }
        if (!isProficiency && maxAllowed && parsed > maxAllowed * 1.5) {
          toast.warning(`Score (${parsed}) exceeds 150% of max score (${maxAllowed}pt).`);
        }
        return parsed;
      };

      if (entry.kind === 'missing') {
        updatedStatus = 'missing';
        numVal = null;
      } else if (entry.kind === 'exempt') {
        updatedStatus = 'exempt';
        numVal = null;
      } else if (entry.kind === 'late') {
        updatedStatus = 'late';
        daysLate = entry.days || daysLate || 1;
        if (entry.score !== undefined) numVal = checkScore(entry.score);
      } else if (entry.kind === 'clear') {
        numVal = null;
        updatedStatus = 'submitted';
      } else if (entry.kind === 'score') {
        numVal = checkScore(entry.score);
        // A plain score keeps "late" (the work is still late) but clears missing/excused
        if (updatedStatus === 'missing' || updatedStatus === 'exempt') {
          updatedStatus = 'submitted';
        }
      } else {
        toast.warning(`"${rawVal}" isn't a score. Use a number, M (missing), L or L3 (late), or E (excused).`);
      }

      const updatedRecord = {
        ...record,
        course_id: this.courseId,
        student_id: studentId,
        assignment_id: assignmentId,
        raw_score: numVal,
        status: updatedStatus,
        days_late: daysLate
      };

      // Push to Undo Stack
      this.pushUndo({
        key,
        prevRecord: JSON.parse(JSON.stringify(record)),
        newRecord: JSON.parse(JSON.stringify(updatedRecord)),
        studentId,
        assignmentId
      });

      this.gradesMap.set(key, updatedRecord);

      if (typeof this.onGradeChange === 'function') {
        this.onGradeChange(updatedRecord, studentId, assignmentId);
      }

      this.activeInputEl = null;
      this.focusedCell = null;
      this.renderWindow();
      this.renderFooterAverages();

      // Navigate if requested
      if (nextRow !== null && nextCol !== null) {
        setTimeout(() => {
          this.activateCellInput(nextRow, nextCol, null);
        }, 30);
      }
    };

    input.addEventListener('blur', () => {
      commitAndNavigate();
    });

    input.addEventListener('keydown', (e) => {
      // 0. Ctrl/Cmd/Alt + Enter -> commit and open the details drawer
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.altKey)) {
        e.preventDefault();
        commitAndNavigate();
        this.openDetails(row, col);
        return;
      }
      // 1. Enter / ArrowDown -> Move Down
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          // Move Up
          const nextR = Math.max(0, row - 1);
          commitAndNavigate(nextR, col);
        } else {
          // Move Down
          const nextR = Math.min(this.students.length - 1, row + 1);
          commitAndNavigate(nextR, col);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextR = Math.min(this.students.length - 1, row + 1);
        commitAndNavigate(nextR, col);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const nextR = Math.max(0, row - 1);
        commitAndNavigate(nextR, col);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          // Tab Left
          let nextC = col - 1;
          let nextR = row;
          if (nextC < 0) {
            nextC = this.assignments.length - 1;
            nextR = Math.max(0, row - 1);
          }
          commitAndNavigate(nextR, nextC);
        } else {
          // Tab Right
          let nextC = col + 1;
          let nextR = row;
          if (nextC >= this.assignments.length) {
            nextC = 0;
            nextR = Math.min(this.students.length - 1, row + 1);
          }
          commitAndNavigate(nextR, nextC);
        }
      } else if (e.key === 'ArrowRight' && (input.selectionStart === input.value.length || input.selectionStart === 0 && input.selectionEnd === input.value.length)) {
        e.preventDefault();
        const nextC = Math.min(this.assignments.length - 1, col + 1);
        commitAndNavigate(row, nextC);
      } else if (e.key === 'ArrowLeft' && (input.selectionStart === 0)) {
        e.preventDefault();
        const nextC = Math.max(0, col - 1);
        commitAndNavigate(row, nextC);
      } else if (e.key === 'Escape') {
        committed = true;
        this.activeInputEl = null;
        this.focusedCell = null;
        this.renderWindow();
      }
    });
  }

  pushUndo(action) {
    this.undoStack.push(action);
    if (this.undoStack.length > 20) {
      this.undoStack.shift();
    }
    this.redoStack = []; // Clear redo on new action
  }

  undo() {
    if (this.undoStack.length === 0) {
      toast.info('Nothing to undo.');
      return;
    }

    const action = this.undoStack.pop();
    this.redoStack.push(action);

    this.gradesMap.set(action.key, action.prevRecord);
    if (typeof this.onGradeChange === 'function') {
      this.onGradeChange(action.prevRecord, action.studentId, action.assignmentId);
    }

    this.renderWindow();
    this.renderFooterAverages();
    toast.info('Undone grade entry.');
  }

  redo() {
    if (this.redoStack.length === 0) {
      toast.info('Nothing to redo.');
      return;
    }

    const action = this.redoStack.pop();
    this.undoStack.push(action);

    this.gradesMap.set(action.key, action.newRecord);
    if (typeof this.onGradeChange === 'function') {
      this.onGradeChange(action.newRecord, action.studentId, action.assignmentId);
    }

    this.renderWindow();
    this.renderFooterAverages();
    toast.info('Redone grade entry.');
  }

  setData(students, assignments, gradesMap, aggregates, rubrics, course) {
    if (course) this.course = course;
    this.students = students || [];
    this.assignments = assignments || [];
    this.gradesMap = gradesMap || new Map();
    this.studentAggregates = aggregates || new Map();
    if (rubrics) this.rubrics = rubrics;
    this.updateDimensions();
    this.renderWindow();
  }
}

export default VirtualGradebookGrid;
