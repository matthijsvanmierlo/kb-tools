/**
 * Interactive Timeline Canvas Renderer & Temporal Zoom Engine (KB-TIME-001)
 * Supports astronomical historical dates (BCE to future), continuous multi-scale zoom,
 * nice-number tick interval algorithm with zero label collision,
 * semantic LOD clustering, vertical scrolling, and interactive bottom minimap.
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
function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
}

export function formatEpochDaysToLabel(epochDays, resolution = 'year') {
  const approxYear = Math.floor(epochDays / 365.25) + 1970;

  if (resolution === 'century') {
    if (approxYear < 0) {
      const bceCent = Math.ceil(Math.abs(approxYear) / 100);
      return `${ordinal(bceCent)} century BCE`;
    }
    const ceCent = Math.floor(approxYear / 100) + 1;
    return `${ordinal(ceCent)} century`;
  }

  if (resolution === 'decade') {
    const decade = Math.floor(approxYear / 10) * 10;
    return approxYear < 0 ? `${Math.abs(decade)}s BCE` : `${decade}s`;
  }

  if (resolution === 'year') {
    return approxYear < 0 ? `${Math.abs(approxYear)} BCE` : `${approxYear}`;
  }

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
  const projected = events.map(ev => {
    const startDay = parseHistoricalDateToDays(ev.start_date);
    const hasEnd = ev.end_date !== null && ev.end_date !== undefined && ev.end_date !== '';
    const endDay = hasEnd ? parseHistoricalDateToDays(ev.end_date) : null;

    const xStart = dayToXFn(startDay);
    const isSpan = endDay !== null && endDay > startDay;

    const estimatedLabelWidth = Math.max(130, (ev.title || '').length * 7.5 + 32);
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

  const laneLastEndPx = [];

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
 * Nice interval steps ladder (in days)
 */
export const NICE_STEPS_DAYS = [
  // Hours
  1 / 24, 2 / 24, 3 / 24, 6 / 24, 12 / 24,
  // Days
  1, 2, 5, 7, 14,
  // Months (~30.4 days)
  30.4375, 60.875, 91.3125, 182.625,
  // Years
  365.25 * 1,
  365.25 * 2,
  365.25 * 5,
  365.25 * 10,
  365.25 * 20,
  365.25 * 25,
  365.25 * 50,
  365.25 * 100,
  365.25 * 200,
  365.25 * 250,
  365.25 * 500,
  365.25 * 1000,
  365.25 * 2000,
  365.25 * 5000,
  365.25 * 10000,
  365.25 * 50000,
  365.25 * 100000,
  365.25 * 500000,
  365.25 * 1000000
];

/**
 * Calculate dynamic nice tick interval in days guaranteeing minimum label spacing
 * @param {number} pixelsPerDay
 * @param {number} minSpacingPx
 * @returns {number} Step size in days
 */
export function calculateNiceTickInterval(pixelsPerDay, minSpacingPx = 110) {
  const minDaysBetweenLabels = minSpacingPx / pixelsPerDay;
  for (const step of NICE_STEPS_DAYS) {
    if (step >= minDaysBetweenLabels) {
      return step;
    }
  }
  return NICE_STEPS_DAYS[NICE_STEPS_DAYS.length - 1];
}

const CANVAS_FONT = '"Inter Variable", Inter, system-ui, -apple-system, sans-serif';

const font = (size, weight = 400) => `${weight} ${size}px ${CANVAS_FONT}`;

/**
 * Canvas colours for the active app theme (canvas cannot read CSS classes directly).
 */
function getCanvasTheme() {
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('sl-theme-dark');
  return isDark
    ? {
        isDark,
        canvasBg: '#111a2b',
        headerBg: '#151e30',
        border: '#2b384f',
        axis: '#37445c',
        minorTick: '#2b384f',
        majorTick: '#7f8ca3',
        label: '#c8d1de',
        muted: '#94a3b8',
        accent: '#60a5fa',
        cardText: '#f1f5f9',
        minimapBg: '#151e30',
        clusterFill: '#4f46e5',
        clusterFillHover: '#6366f1',
        clusterStroke: '#151e30'
      }
    : {
        isDark,
        canvasBg: '#f8fafc',
        headerBg: '#ffffff',
        border: '#e2e8f0',
        axis: '#cbd5e1',
        minorTick: '#e2e8f0',
        majorTick: '#64748b',
        label: '#334155',
        muted: '#64748b',
        accent: '#2563eb',
        cardText: '#0f172a',
        minimapBg: '#f1f5f9',
        clusterFill: '#4f46e5',
        clusterFillHover: '#4338ca',
        clusterStroke: '#ffffff'
      };
}

/** Blend a hex colour with the card background to produce a soft tint */
function tint(hex, theme, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return theme.headerBg;
  const n = parseInt(m[1], 16);
  const bg = parseInt(theme.headerBg.slice(1), 16);
  const ch = (v, shift) => (v >> shift) & 255;
  const mix = (shift) => Math.round(ch(n, shift) * amount + ch(bg, shift) * (1 - amount));
  return `rgb(${mix(16)}, ${mix(8)}, ${mix(0)})`;
}

// Repaint the visible timeline when the user switches theme
if (typeof window !== 'undefined') {
  window.addEventListener('kb-theme-changed', () => {
    const active = TimelineCanvasRenderer.active;
    if (active && active.canvas?.isConnected) active.render();
  });
}

export class TimelineCanvasRenderer {
  constructor(canvas, dataset, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext ? canvas.getContext('2d') : null;
    this.dataset = dataset;
    this.events = dataset.events || [];
    this.onSelectEvent = options.onSelectEvent || null;
    this.onScaleChange = options.onScaleChange || null;

    this.pixelsPerDay = options.initialPixelsPerDay || 0.05;
    this.centerDay = options.initialCenterDay || 0;

    if (this.events.length > 0) {
      const days = this.events.map(e => parseHistoricalDateToDays(e.start_date));
      const minDay = Math.min(...days);
      const maxDay = Math.max(...days);
      this.centerDay = (minDay + maxDay) / 2;
      const spanDays = Math.max(30, maxDay - minDay);
      const viewportWidth = (this.canvas.clientWidth || 900);
      this.pixelsPerDay = Math.max(1e-4, Math.min(2400, viewportWidth / (spanDays * 1.6)));
    }

    this.focusedEventIndex = 0;
    this.hoveredItem = null;
    this.hoveredCluster = null;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragStartCenterDay = 0;
    this.dragStartScrollY = 0;

    this.scrollY = 0;
    this.maxScrollY = 0;

    this.laneHeight = 44;
    this.axisY = 64;
    this.lanesStartY = 110;
    this.minimapHeight = 36;

    this.isMinimapDragging = false;

    TimelineCanvasRenderer.active = this;
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

  getScaleLabel() {
    const ppd = this.pixelsPerDay;
    if (ppd > 120) return 'Hours';
    if (ppd >= 5) return 'Days';
    if (ppd >= 0.2) return 'Months';
    if (ppd >= 0.02) return 'Years';
    if (ppd >= 0.002) return 'Decades';
    if (ppd >= 0.0002) return 'Centuries';
    return 'Millennia';
  }

  _bindEvents() {
    if (!this.canvas) return;
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

    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Horizontal pan
      this.centerDay += (e.deltaX || e.deltaY) / this.pixelsPerDay;
      this.render();
      return;
    }

    if (e.ctrlKey || e.metaKey || !e.altKey) {
      // Zoom
      const cursorX = e.clientX - rect.left;
      const cursorDay = this.screenXToDay(cursorX);

      const factor = e.deltaY < 0 ? 1.2 : 0.833;
      const newPpd = Math.max(1e-5, Math.min(2400, this.pixelsPerDay * factor));
      this.pixelsPerDay = newPpd;

      const viewportWidth = rect.width || 900;
      this.centerDay = cursorDay - (cursorX - viewportWidth / 2) / this.pixelsPerDay;

      if (this.onScaleChange) this.onScaleChange(this.getScaleLabel());
      this.render();
    }
  }

  _onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const height = rect.height || 500;

    // Check if clicking in bottom minimap
    if (y >= height - this.minimapHeight) {
      this.isMinimapDragging = true;
      this._handleMinimapClick(x, rect.width || 900);
      return;
    }

    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.dragStartCenterDay = this.centerDay;
    this.dragStartScrollY = this.scrollY;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch (_) {}
  }

  _onPointerMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (this.isMinimapDragging) {
      this._handleMinimapClick(mouseX, rect.width || 900);
      return;
    }

    if (this.isDragging) {
      const deltaX = e.clientX - this.dragStartX;
      const deltaY = e.clientY - this.dragStartY;

      this.centerDay = this.dragStartCenterDay - deltaX / this.pixelsPerDay;
      this.scrollY = Math.max(0, Math.min(this.maxScrollY, this.dragStartScrollY - deltaY));
      this.render();
      return;
    }

    // Hit test
    const { hitItem, hitCluster } = this._hitTest(mouseX, mouseY);
    if (hitItem !== this.hoveredItem || hitCluster !== this.hoveredCluster) {
      this.hoveredItem = hitItem;
      this.hoveredCluster = hitCluster;
      this.canvas.style.cursor = (hitItem || hitCluster) ? 'pointer' : 'default';
      this.render();
    }
  }

  _onPointerUp(e) {
    this.isMinimapDragging = false;
    if (!this.isDragging) return;

    const deltaX = Math.abs(e.clientX - this.dragStartX);
    const deltaY = Math.abs(e.clientY - this.dragStartY);
    this.isDragging = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch (_) {}

    // Click threshold
    if (deltaX < 5 && deltaY < 5) {
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const { hitItem, hitCluster } = this._hitTest(mouseX, mouseY);

      if (hitCluster) {
        this._zoomToCluster(hitCluster);
      } else if (hitItem && typeof this.onSelectEvent === 'function') {
        this.onSelectEvent(hitItem);
      }
    }
  }

  _zoomToCluster(cluster) {
    const span = Math.max(10, cluster.endDay - cluster.startDay);
    const targetCenter = (cluster.startDay + cluster.endDay) / 2;
    const viewportWidth = (this.canvas.getBoundingClientRect().width || 900);
    const targetPpd = Math.min(2400, viewportWidth / (span * 2.5));

    // Smooth animate zoom
    const startCenter = this.centerDay;
    const startPpd = this.pixelsPerDay;
    const duration = 350;
    const startTime = performance.now();

    const animate = (currentTime) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(1, elapsed / duration);
      // easeOutCubic
      const ease = 1 - Math.pow(1 - progress, 3);

      this.centerDay = startCenter + (targetCenter - startCenter) * ease;
      this.pixelsPerDay = startPpd + (targetPpd - startPpd) * ease;
      this.render();

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        if (this.onScaleChange) this.onScaleChange(this.getScaleLabel());
      }
    };

    requestAnimationFrame(animate);
  }

  _handleMinimapClick(screenX, width) {
    if (this.events.length === 0) return;
    const days = this.events.map(e => parseHistoricalDateToDays(e.start_date));
    const minDay = Math.min(...days);
    const maxDay = Math.max(...days);
    const padding = Math.max(365, (maxDay - minDay) * 0.1);
    const globalStart = minDay - padding;
    const globalSpan = Math.max(100, (maxDay + padding) - globalStart);

    const ratio = Math.max(0, Math.min(1, (screenX - 16) / (width - 32)));
    this.centerDay = globalStart + ratio * globalSpan;
    this.render();
  }

  _onKeyDown(e) {
    const { items } = this._getLODItems();
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
      if (current?.isCluster) {
        this._zoomToCluster(current);
      } else if (current && typeof this.onSelectEvent === 'function') {
        this.onSelectEvent(current);
      }
    }
  }

  _focusEvent(ev) {
    const eventX = this.dayToScreenX(ev.startDay);
    const viewportWidth = this.canvas.getBoundingClientRect().width || 900;

    if (eventX < 100 || eventX > viewportWidth - 100) {
      this.centerDay = ev.startDay;
    }

    if (typeof document !== 'undefined') {
      const live = document.getElementById('timeline-aria-live');
      if (live) {
        if (ev.isCluster) {
          live.textContent = `Cluster of ${ev.count} events from ${ev.start_date} to ${ev.end_date}.`;
        } else {
          const spanDesc = ev.end_date ? `Span from ${ev.start_date} to ${ev.end_date}` : `Milestone on ${ev.start_date}`;
          live.textContent = `${ev.title}, ${spanDesc}, Category: ${ev.category || 'General'}.`;
        }
      }
    }

    this.render();
  }

  _getLODItems() {
    // 1. If zoomed out significantly and events are dense, cluster them
    const CLUSTER_THRESHOLD_PX = 28;
    const rawProjected = assignTimelineLanes(this.events, (d) => this.dayToScreenX(d));

    // When dense and lanes exceed 5, run cluster aggregation
    if (this.pixelsPerDay < 0.01 && rawProjected.totalLanes > 5) {
      const sorted = [...this.events].sort((a, b) => parseHistoricalDateToDays(a.start_date) - parseHistoricalDateToDays(b.start_date));
      const clusters = [];
      let currentCluster = null;

      for (const ev of sorted) {
        const startDay = parseHistoricalDateToDays(ev.start_date);
        const endDay = ev.end_date ? parseHistoricalDateToDays(ev.end_date) : startDay;
        const screenX = this.dayToScreenX(startDay);

        if (!currentCluster) {
          currentCluster = {
            isCluster: true,
            id: `cluster-${ev.id}`,
            startDay,
            endDay,
            start_date: ev.start_date,
            end_date: ev.end_date || ev.start_date,
            events: [ev],
            xStart: screenX,
            xEnd: screenX + 110,
            color: '#4f46e5',
            title: `+1 Event`,
            lane: 0
          };
        } else {
          const clusterScreenX = this.dayToScreenX(currentCluster.startDay);
          if (Math.abs(screenX - clusterScreenX) < CLUSTER_THRESHOLD_PX) {
            currentCluster.events.push(ev);
            currentCluster.endDay = Math.max(currentCluster.endDay, endDay);
            currentCluster.end_date = ev.end_date || ev.start_date;
            currentCluster.title = `+${currentCluster.events.length} Events`;
          } else {
            clusters.push(currentCluster);
            currentCluster = {
              isCluster: true,
              id: `cluster-${ev.id}`,
              startDay,
              endDay,
              start_date: ev.start_date,
              end_date: ev.end_date || ev.start_date,
              events: [ev],
              xStart: screenX,
              xEnd: screenX + 110,
              color: '#4f46e5',
              title: `+1 Event`,
              lane: 0
            };
          }
        }
      }
      if (currentCluster) clusters.push(currentCluster);

      // Distribute clusters across minimal lanes
      const packed = assignTimelineLanes(clusters, (d) => this.dayToScreenX(d));
      return packed;
    }

    return rawProjected;
  }

  _hitTest(x, y) {
    const { items } = this._getLODItems();
    const effectiveY = y + this.scrollY;

    for (const item of items) {
      const laneY = this.lanesStartY + item.lane * this.laneHeight;
      const cardHeight = 32;

      if (effectiveY >= laneY && effectiveY <= laneY + cardHeight) {
        if (x >= item.xStart && x <= item.xEnd) {
          if (item.isCluster) {
            return { hitItem: null, hitCluster: item };
          }
          return { hitItem: item, hitCluster: null };
        }
      }
    }
    return { hitItem: null, hitCluster: null };
  }

  render() {
    const ctx = this.ctx;
    if (!ctx) return;

    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 900;
    const height = Math.max(500, rect.height || 500);

    ctx.clearRect(0, 0, width, height);
    this.theme = getCanvasTheme();

    // Canvas background
    ctx.fillStyle = this.theme.canvasBg;
    ctx.fillRect(0, 0, width, height);

    // Draw Temporal Grid & Axis Ticks with collision prevention
    this._renderAxis(ctx, width, height);

    // Dynamic Items Allocation (Cards / Clusters)
    const { items, totalLanes } = this._getLODItems();

    // Compute max vertical scroll
    const totalRequiredHeight = this.lanesStartY + totalLanes * this.laneHeight + 60;
    this.maxScrollY = Math.max(0, totalRequiredHeight - height);

    // Draw events inside scroll viewport
    ctx.save();
    // Clip below axis and above minimap
    ctx.beginPath();
    ctx.rect(0, this.axisY + 12, width, height - this.axisY - 12 - this.minimapHeight);
    ctx.clip();

    ctx.translate(0, -this.scrollY);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isFocused = i === this.focusedEventIndex;
      const isHovered = (this.hoveredItem && this.hoveredItem.id === item.id) ||
                        (this.hoveredCluster && this.hoveredCluster.id === item.id);

      if (item.isCluster) {
        this._renderClusterItem(ctx, item, isHovered);
      } else {
        this._renderEventItem(ctx, item, isFocused, isHovered);
      }
    }

    ctx.restore();

    // Render Minimap Navigator at bottom
    this._renderMinimap(ctx, width, height);

    // Render cluster hover preview tooltip
    if (this.hoveredCluster) {
      this._renderClusterTooltip(ctx, this.hoveredCluster, width);
    }
  }

  _renderAxis(ctx, width, height) {
    ctx.save();
    const t = this.theme || getCanvasTheme();

    // Two-tier top background banner
    ctx.fillStyle = t.headerBg;
    ctx.fillRect(0, 0, width, this.axisY + 12);
    ctx.strokeStyle = t.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, this.axisY + 12);
    ctx.lineTo(width, this.axisY + 12);
    ctx.stroke();

    // Upper context bar
    const leftDay = this.screenXToDay(0);
    const rightDay = this.screenXToDay(width);
    const leftLabel = formatEpochDaysToLabel(leftDay, 'year');
    const rightLabel = formatEpochDaysToLabel(rightDay, 'year');
    const scaleTitle = this.getScaleLabel();

    ctx.fillStyle = t.muted;
    ctx.font = font(11, 600);
    ctx.textAlign = 'left';
    ctx.fillText(`Showing ${leftLabel} — ${rightLabel}`, 16, 24);

    ctx.textAlign = 'right';
    ctx.fillStyle = t.accent;
    ctx.fillText(`Scale: ${scaleTitle}`, width - 16, 24);

    // Major Axis baseline line
    ctx.strokeStyle = t.axis;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, this.axisY);
    ctx.lineTo(width, this.axisY);
    ctx.stroke();

    // Nice-Number Interval Solver
    // Guarantee minimum label spacing: 110px
    const MIN_TICK_SPACING_PX = 110;
    const minDaysBetweenLabels = MIN_TICK_SPACING_PX / this.pixelsPerDay;

    let chosenStepDays = NICE_STEPS_DAYS[NICE_STEPS_DAYS.length - 1];
    for (const step of NICE_STEPS_DAYS) {
      if (step >= minDaysBetweenLabels) {
        chosenStepDays = step;
        break;
      }
    }

    // Determine calendar alignment and snapping
    const firstTickDay = Math.floor(leftDay / chosenStepDays) * chosenStepDays;
    const lastTickDay = Math.ceil(rightDay / chosenStepDays) * chosenStepDays;

    ctx.font = font(11, 500);
    ctx.textAlign = 'center';

    let lastLabelRightPx = -999;

    for (let d = firstTickDay; d <= lastTickDay; d += chosenStepDays) {
      const x = this.dayToScreenX(d);
      if (x < -60 || x > width + 60) continue;

      // Draw minor subdivision ticks between major ticks
      const subTicks = 4;
      ctx.strokeStyle = t.minorTick;
      ctx.lineWidth = 1;
      for (let s = 1; s < subTicks; s++) {
        const subX = this.dayToScreenX(d + (chosenStepDays / subTicks) * s);
        if (subX >= 0 && subX <= width) {
          ctx.beginPath();
          ctx.moveTo(subX, this.axisY - 3);
          ctx.lineTo(subX, this.axisY + 3);
          ctx.stroke();
        }
      }

      // Major tick mark
      ctx.strokeStyle = t.majorTick;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, this.axisY - 6);
      ctx.lineTo(x, this.axisY + 6);
      ctx.stroke();

      // Format label
      let resolution = 'year';
      if (chosenStepDays >= 365.25 * 100) resolution = 'century';
      else if (chosenStepDays >= 365.25 * 10) resolution = 'decade';
      else if (chosenStepDays >= 365.25) resolution = 'year';
      else if (chosenStepDays >= 28) resolution = 'month';
      else if (chosenStepDays >= 1) resolution = 'day';
      else resolution = 'hour';

      const label = formatEpochDaysToLabel(d, resolution);
      const textWidth = ctx.measureText ? ctx.measureText(label).width : 50;

      // Collision Guard: only draw text label if at least 12px away from prior label,
      // and keep it fully inside the canvas instead of clipping at the edges
      const fitsInside = x - textWidth / 2 >= 4 && x + textWidth / 2 <= width - 4;
      if (fitsInside && x - textWidth / 2 >= lastLabelRightPx + 12) {
        ctx.fillStyle = t.label;
        ctx.fillText(label, x, this.axisY - 10);
        lastLabelRightPx = x + textWidth / 2;
      }
    }

    ctx.restore();
  }

  _renderEventItem(ctx, item, isFocused, isHovered) {
    ctx.save();
    const t = this.theme || getCanvasTheme();
    const color = item.color || '#3b82f6';

    const laneY = this.lanesStartY + item.lane * this.laneHeight;
    const cardHeight = 32;
    const cardWidth = Math.max(140, item.xEnd - item.xStart);

    // Connector line from axis to milestone
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(item.xStart, this.axisY);
    ctx.lineTo(item.xStart, laneY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Milestone dot with a halo so it reads against the axis line
    ctx.fillStyle = t.headerBg;
    ctx.beginPath();
    ctx.arc(item.xStart, this.axisY, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(item.xStart, this.axisY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Event card: soft tinted body with a solid accent bar
    const radius = 8;
    if (isHovered || isFocused) {
      ctx.shadowColor = t.isDark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(15, 23, 42, 0.14)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 3;
    }
    ctx.fillStyle = item.isSpan ? tint(color, t, isHovered ? 0.3 : 0.22) : tint(color, t, isHovered ? 0.14 : 0.08);
    ctx.beginPath();
    ctx.roundRect(item.xStart, laneY, cardWidth, cardHeight, radius);
    ctx.fill();
    ctx.shadowColor = 'transparent';

    ctx.strokeStyle = color;
    ctx.globalAlpha = isFocused || isHovered ? 1 : 0.55;
    ctx.lineWidth = isFocused ? 2 : 1;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(item.xStart, laneY, 4, cardHeight, [radius, 0, 0, radius]);
    ctx.fill();

    // Card Text
    ctx.fillStyle = t.cardText;
    ctx.font = font(12, isFocused ? 700 : 600);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.title || 'Untitled', item.xStart + 14, laneY + cardHeight / 2 + 0.5, cardWidth - 24);

    ctx.restore();
  }

  _renderClusterItem(ctx, cluster, isHovered) {
    ctx.save();

    const laneY = this.lanesStartY + cluster.lane * this.laneHeight;
    const cardHeight = 30;
    const cardWidth = 120;

    const t = this.theme || getCanvasTheme();

    // Line to axis
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cluster.xStart, this.axisY);
    ctx.lineTo(cluster.xStart, laneY);
    ctx.stroke();

    // Cluster Badge Pill
    ctx.fillStyle = isHovered ? t.clusterFillHover : t.clusterFill;
    ctx.strokeStyle = t.clusterStroke;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.roundRect(cluster.xStart, laneY, cardWidth, cardHeight, 15);
    ctx.fill();
    ctx.stroke();

    // Text
    ctx.fillStyle = '#ffffff';
    ctx.font = font(11, 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${cluster.events.length} events · zoom`, cluster.xStart + cardWidth / 2, laneY + cardHeight / 2 + 0.5);

    ctx.restore();
  }

  _renderClusterTooltip(ctx, cluster, canvasWidth) {
    ctx.save();
    const tooltipX = Math.min(canvasWidth - 220, Math.max(16, cluster.xStart - 50));
    const tooltipY = this.lanesStartY + (cluster.lane + 1) * this.laneHeight - this.scrollY + 5;
    const count = cluster.events.length;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.roundRect(tooltipX, tooltipY, 220, 24 + Math.min(4, count) * 18, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#93c5fd';
    ctx.font = font(11, 700);
    ctx.textAlign = 'left';
    ctx.fillText(`${count} Events in this Era (Click to Zoom):`, tooltipX + 8, tooltipY + 16);

    ctx.font = font(11, 400);
    ctx.fillStyle = '#f8fafc';
    cluster.events.slice(0, 4).forEach((ev, idx) => {
      const line = `• ${ev.title} (${ev.start_date})`;
      ctx.fillText(line, tooltipX + 8, tooltipY + 34 + idx * 18, 204);
    });

    ctx.restore();
  }

  _renderMinimap(ctx, width, height) {
    ctx.save();

    const minimapY = height - this.minimapHeight;
    const t = this.theme || getCanvasTheme();

    // Minimap surface background
    ctx.fillStyle = t.minimapBg;
    ctx.fillRect(0, minimapY, width, this.minimapHeight);
    ctx.strokeStyle = t.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, minimapY);
    ctx.lineTo(width, minimapY);
    ctx.stroke();

    if (this.events.length === 0) {
      ctx.restore();
      return;
    }

    const days = this.events.map(e => parseHistoricalDateToDays(e.start_date));
    const minDay = Math.min(...days);
    const maxDay = Math.max(...days);
    const padding = Math.max(365, (maxDay - minDay) * 0.1);
    const globalStart = minDay - padding;
    const globalSpan = Math.max(100, (maxDay + padding) - globalStart);

    const mapDayToX = (d) => 16 + ((d - globalStart) / globalSpan) * (width - 32);

    // Draw miniature ticks/events
    for (const ev of this.events) {
      const day = parseHistoricalDateToDays(ev.start_date);
      const mx = mapDayToX(day);
      ctx.fillStyle = ev.color || '#3b82f6';
      ctx.beginPath();
      ctx.roundRect(mx - 1.5, minimapY + 10, 3, this.minimapHeight - 20, 1.5);
      ctx.fill();
    }

    // Viewport shaded rectangle
    const visibleLeftDay = this.screenXToDay(0);
    const visibleRightDay = this.screenXToDay(width);

    const vpLeftX = Math.max(0, mapDayToX(visibleLeftDay));
    const vpRightX = Math.min(width, mapDayToX(visibleRightDay));
    const vpWidth = Math.max(16, vpRightX - vpLeftX);

    ctx.fillStyle = t.isDark ? 'rgba(96, 165, 250, 0.12)' : 'rgba(37, 99, 235, 0.08)';
    ctx.strokeStyle = t.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(vpLeftX, minimapY + 2, vpWidth, this.minimapHeight - 4, 4);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }
}

export default TimelineCanvasRenderer;
