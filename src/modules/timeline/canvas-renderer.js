/**
 * Interactive Timeline Canvas Renderer & Temporal Zoom Engine (KB-TIME-001)
 * Supports astronomical historical dates (BCE to future), continuous wheel zoom (Hours to Centuries),
 * greedy interval lane allocation, and keyboard/screen reader accessibility.
 */

/**
 * Extended Historical Date Parser
 * Converts ISO strings (-0044-03-15, 1517-10-31, 2026-10-17) or year integers (-44, 1618)
 * into a continuous astronomical epoch day float (where 1970-01-01 = day 0.0).
 * 1 Julian astronomical year = 365.25 days.
 * @param {string|number} dateStr
 * @returns {number} Epoch days float
 */
export function parseHistoricalDateToDays(dateStr) {
  if (dateStr === null || dateStr === undefined) return 0;
  if (typeof dateStr === 'number') {
    // Treat as pure year integer
    return (dateStr - 1970) * 365.25;
  }

  const str = String(dateStr).trim();

  // Pure signed year integer, e.g. "-44", "1618", "2026"
  if (/^-?\d+$/.test(str)) {
    const year = parseInt(str, 10);
    return (year - 1970) * 365.25;
  }

  // Check for ISO-style date e.g. "-0044-03-15" or "1517-10-31" or "1969-07-20"
  const isoMatch = str.match(/^(-?\d+)-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):?(\d{2})?)?/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10); // 1-12
    const day = parseInt(isoMatch[3], 10); // 1-31
    const hours = parseInt(isoMatch[4] || '0', 10);
    const minutes = parseInt(isoMatch[5] || '0', 10);
    const seconds = parseInt(isoMatch[6] || '0', 10);

    // Days into year approximation:
    const monthDays = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    const dayOfYear = (monthDays[month - 1] || 0) + (day - 1) + (isLeap && month > 2 ? 1 : 0);
    const fractionOfDay = (hours * 3600 + minutes * 60 + seconds) / 86400;

    return (year - 1970) * 365.25 + dayOfYear + fractionOfDay;
  }

  // Fallback to Date.parse for modern strings
  const parsed = Date.parse(str);
  if (!isNaN(parsed)) {
    return parsed / 86400000;
  }

  return 0;
}

/**
 * Format epoch days back into human-readable historical date string
 * @param {number} epochDays
 * @param {'hour' | 'day' | 'month' | 'year' | 'decade' | 'century'} resolution
 * @returns {string}
 */
export function formatEpochDaysToLabel(epochDays, resolution = 'year') {
  const approxYear = Math.floor(epochDays / 365.25) + 1970;

  if (resolution === 'century') {
    if (approxYear < 0) {
      const bceCent = Math.ceil(Math.abs(approxYear) / 100);
      return `${bceCent}th Century BCE`;
    }
    const ceCent = Math.floor(approxYear / 100) + 1;
    return `${ceCent}th Century`;
  }

  if (resolution === 'decade') {
    const decade = Math.floor(approxYear / 10) * 10;
    return approxYear < 0 ? `${Math.abs(decade)}s BCE` : `${decade}s`;
  }

  if (resolution === 'year') {
    return approxYear < 0 ? `${Math.abs(approxYear)} BCE` : `${approxYear}`;
  }

  // For modern dates with days or hours, use standard UTC formatting
  const ms = epochDays * 86400000;
  if (ms >= -62135596800000) { // On or after year 0
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      if (resolution === 'month') {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      }
      if (resolution === 'day') {
        return d.toISOString().split('T')[0];
      }
      if (resolution === 'hour') {
        return `${d.toISOString().split('T')[0]} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
      }
    }
  }

  return approxYear < 0 ? `${Math.abs(approxYear)} BCE` : `${approxYear}`;
}

/**
 * Greedy Interval Partitioning (Automated Collision & Lane Allocation)
 * Prevents overlapping event cards and duration spans.
 * @param {any[]} events
 * @param {(day: number) => number} dayToXFn
 * @param {number} [minGapPx=16]
 * @returns {{ items: any[], totalLanes: number }}
 */
export function assignTimelineLanes(events, dayToXFn, minGapPx = 16) {
  // 1. Project events to screen X intervals [xStart, xEnd]
  const projected = events.map(ev => {
    const startDay = parseHistoricalDateToDays(ev.start_date);
    const hasEnd = ev.end_date !== null && ev.end_date !== undefined && ev.end_date !== '';
    const endDay = hasEnd ? parseHistoricalDateToDays(ev.end_date) : null;

    const xStart = dayToXFn(startDay);
    const isSpan = endDay !== null && endDay > startDay;

    // Milestones require a minimum pill width based on title character count
    const estimatedLabelWidth = Math.max(130, ev.title.length * 7.5 + 32);
    const xEnd = isSpan
      ? Math.max(dayToXFn(endDay), xStart + estimatedLabelWidth)
      : xStart + estimatedLabelWidth;

    return {
      ...ev,
      startDay,
      endDay,
      isSpan,
      xStart,
      xEnd
    };
  }).sort((a, b) => a.xStart - b.xStart || b.xEnd - a.xEnd);

  // 2. Greedy lane packing
  const laneLastEndPx = []; // Tracks rightmost occupied X coordinate per horizontal lane

  for (const item of projected) {
    let assignedLane = -1;

    for (let laneIdx = 0; laneIdx < laneLastEndPx.length; laneIdx++) {
      if (item.xStart >= laneLastEndPx[laneIdx] + minGapPx) {
        assignedLane = laneIdx;
        laneLastEndPx[laneIdx] = item.xEnd;
        break;
      }
    }

    if (assignedLane === -1) {
      assignedLane = laneLastEndPx.length;
      laneLastEndPx.push(item.xEnd);
    }

    item.lane = assignedLane;
  }

  return { items: projected, totalLanes: Math.max(1, laneLastEndPx.length) };
}

/**
 * Timeline Canvas Renderer
 */
export class TimelineCanvasRenderer {
  constructor(canvas, dataset, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dataset = dataset;
    this.events = dataset.events || [];
    this.onSelectEvent = options.onSelectEvent || null;

    // Temporal Zoom State
    // pixelsPerDay: scale factor
    this.pixelsPerDay = options.initialPixelsPerDay || 0.1; // Default ~Years resolution
    this.centerDay = options.initialCenterDay || 0; // Epoch days focal point

    if (this.events.length > 0) {
      // Auto-focus around first event or average
      const days = this.events.map(e => parseHistoricalDateToDays(e.start_date));
      const minDay = Math.min(...days);
      const maxDay = Math.max(...days);
      this.centerDay = (minDay + maxDay) / 2;
      const spanDays = Math.max(30, maxDay - minDay);
      this.pixelsPerDay = Math.max(1e-4, Math.min(2400, (this.canvas.clientWidth || 900) / (spanDays * 1.5)));
    }

    this.focusedEventIndex = 0;
    this.hoveredItem = null;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartCenterDay = 0;

    this.laneHeight = 44;
    this.axisY = 60; // Top axis position
    this.lanesStartY = 110;

    this._bindEvents();
    this.resize();
  }

  resize() {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 900;
    const height = Math.max(500, rect.height || 500);

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    if (this.ctx) {
      if (this.ctx.resetTransform) this.ctx.resetTransform();
      if (this.ctx.scale) this.ctx.scale(dpr, dpr);
    }
    this.render();
  }

  dayToScreenX(day) {
    const viewportWidth = this.canvas.getBoundingClientRect().width || 900;
    return viewportWidth / 2 + (day - this.centerDay) * this.pixelsPerDay;
  }

  screenXToDay(screenX) {
    const viewportWidth = this.canvas.getBoundingClientRect().width || 900;
    return this.centerDay + (screenX - viewportWidth / 2) / this.pixelsPerDay;
  }

  _bindEvents() {
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointerleave', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('keydown', (e) => this._onKeyDown(e));
  }

  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;

    // Pin point under cursor
    const cursorDay = this.screenXToDay(cursorX);

    // Zoom multiplier
    const factor = e.deltaY < 0 ? 1.18 : 0.85;
    const newPixelsPerDay = Math.max(1e-4, Math.min(2400, this.pixelsPerDay * factor));

    this.pixelsPerDay = newPixelsPerDay;
    // Re-adjust centerDay so cursorDay stays pinned under cursorX
    const viewportWidth = rect.width;
    this.centerDay = cursorDay - (cursorX - viewportWidth / 2) / this.pixelsPerDay;

    this.render();
  }

  _onPointerDown(e) {
    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartCenterDay = this.centerDay;
    this.canvas.setPointerCapture(e.pointerId);
  }

  _onPointerMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (this.isDragging) {
      const deltaPx = e.clientX - this.dragStartX;
      const deltaDays = deltaPx / this.pixelsPerDay;
      this.centerDay = this.dragStartCenterDay - deltaDays;
      this.render();
      return;
    }

    // Hit test for hover
    const hit = this._hitTest(mouseX, mouseY);
    if (hit !== this.hoveredItem) {
      this.hoveredItem = hit;
      this.canvas.style.cursor = hit ? 'pointer' : 'default';
      this.render();
    }
  }

  _onPointerUp(e) {
    if (!this.isDragging) return;
    const deltaX = Math.abs(e.clientX - this.dragStartX);
    this.isDragging = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch (_) {}

    // If small movement, treat as click
    if (deltaX < 5) {
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const hit = this._hitTest(mouseX, mouseY);
      if (hit && typeof this.onSelectEvent === 'function') {
        this.onSelectEvent(hit);
      }
    }
  }

  _onKeyDown(e) {
    const { items } = assignTimelineLanes(this.events, (d) => this.dayToScreenX(d));
    if (items.length === 0) return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.focusedEventIndex = Math.min(items.length - 1, this.focusedEventIndex + 1);
      this._focusEvent(items[this.focusedEventIndex]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.focusedEventIndex = Math.max(0, this.focusedEventIndex - 1);
      this._focusEvent(items[this.focusedEventIndex]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const current = items[this.focusedEventIndex];
      if (current && typeof this.onSelectEvent === 'function') {
        this.onSelectEvent(current);
      }
    }
  }

  _focusEvent(ev) {
    // Smoothly pan centerDay if event is outside viewport
    const eventX = this.dayToScreenX(ev.startDay);
    const viewportWidth = this.canvas.getBoundingClientRect().width || 900;

    if (eventX < 100 || eventX > viewportWidth - 100) {
      this.centerDay = ev.startDay;
    }

    // Update screen reader announcer
    if (typeof document !== 'undefined') {
      const live = document.getElementById('timeline-aria-live');
      if (live) {
        const spanDesc = ev.end_date
          ? `Span from ${ev.start_date} to ${ev.end_date}`
          : `Milestone on ${ev.start_date}`;
        live.textContent = `${ev.title}, ${spanDesc}, Category: ${ev.category || 'General'}.`;
      }
    }

    this.render();
  }

  _hitTest(x, y) {
    const { items } = assignTimelineLanes(this.events, (d) => this.dayToScreenX(d));

    for (const item of items) {
      const laneY = this.lanesStartY + item.lane * this.laneHeight;
      const cardHeight = 32;

      if (y >= laneY && y <= laneY + cardHeight) {
        if (x >= item.xStart && x <= item.xEnd) {
          return item;
        }
      }
    }
    return null;
  }

  getResolution() {
    const ppd = this.pixelsPerDay;
    if (ppd > 120) return 'hour';
    if (ppd >= 10) return 'day';
    if (ppd >= 0.5) return 'month';
    if (ppd >= 0.05) return 'year';
    if (ppd >= 0.005) return 'decade';
    return 'century';
  }

  render() {
    const ctx = this.ctx;
    if (!ctx) return;

    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 900;
    const height = Math.max(500, rect.height || 500);

    ctx.clearRect(0, 0, width, height);

    // Background
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, width, height);

    // Draw Temporal Grid & Axis Ticks
    this._renderAxis(ctx, width, height);

    // Run Collision & Lane Allocation
    const { items, totalLanes } = assignTimelineLanes(this.events, (d) => this.dayToScreenX(d));

    // Render Event Items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isFocused = i === this.focusedEventIndex;
      const isHovered = this.hoveredItem && this.hoveredItem.id === item.id;
      this._renderEventItem(ctx, item, isFocused, isHovered);
    }
  }

  _renderAxis(ctx, width, height) {
    const resolution = this.getResolution();
    ctx.save();

    // Axis baseline
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, this.axisY);
    ctx.lineTo(width, this.axisY);
    ctx.stroke();

    // Determine interval in days for ticks
    let tickIntervalDays = 365.25; // 1 year
    if (resolution === 'century') tickIntervalDays = 365.25 * 100;
    else if (resolution === 'decade') tickIntervalDays = 365.25 * 10;
    else if (resolution === 'year') tickIntervalDays = 365.25;
    else if (resolution === 'month') tickIntervalDays = 30.5;
    else if (resolution === 'day') tickIntervalDays = 1.0;
    else if (resolution === 'hour') tickIntervalDays = 1 / 24;

    const leftDay = this.screenXToDay(0);
    const rightDay = this.screenXToDay(width);

    const firstTickDay = Math.floor(leftDay / tickIntervalDays) * tickIntervalDays;

    ctx.strokeStyle = '#e2e8f0';
    ctx.fillStyle = '#64748b';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';

    for (let d = firstTickDay; d <= rightDay; d += tickIntervalDays) {
      const x = this.dayToScreenX(d);

      // Vertical gridline
      ctx.beginPath();
      ctx.moveTo(x, this.axisY);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Tick mark on axis
      ctx.beginPath();
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1.5;
      ctx.moveTo(x, this.axisY - 6);
      ctx.lineTo(x, this.axisY + 6);
      ctx.stroke();
      ctx.strokeStyle = '#e2e8f0';

      // Axis Label
      const label = formatEpochDaysToLabel(d, resolution);
      ctx.fillText(label, x, this.axisY - 12);
    }

    ctx.restore();
  }

  _renderEventItem(ctx, item, isFocused, isHovered) {
    ctx.save();

    const laneY = this.lanesStartY + item.lane * this.laneHeight;
    const cardHeight = 30;
    const cardWidth = Math.max(130, item.xEnd - item.xStart);

    // Connector line from axis to milestone/span
    ctx.strokeStyle = item.color || '#3b82f6';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(item.xStart, this.axisY);
    ctx.lineTo(item.xStart, laneY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Milestone circle on axis
    ctx.fillStyle = item.color || '#3b82f6';
    ctx.beginPath();
    ctx.arc(item.xStart, this.axisY, 4, 0, Math.PI * 2);
    ctx.fill();

    // Event Card / Span Box
    ctx.fillStyle = isHovered ? '#ffffff' : (item.isSpan ? item.color : '#ffffff');
    ctx.strokeStyle = item.color || '#3b82f6';
    ctx.lineWidth = isFocused || isHovered ? 2.5 : 1.5;

    // Draw rounded rect
    const radius = 6;
    ctx.beginPath();
    ctx.roundRect(item.xStart, laneY, cardWidth, cardHeight, radius);
    ctx.fill();
    ctx.stroke();

    // Text label
    const textColor = item.isSpan && !isHovered ? '#ffffff' : '#0f172a';
    ctx.fillStyle = textColor;
    ctx.font = isFocused ? 'bold 12px system-ui, sans-serif' : '11px system-ui, sans-serif';
    ctx.textAlign = 'left';

    // Date badge prefix
    const dateText = item.start_date;
    ctx.fillText(item.title, item.xStart + 8, laneY + 18, cardWidth - 16);

    ctx.restore();
  }
}

export default TimelineCanvasRenderer;
