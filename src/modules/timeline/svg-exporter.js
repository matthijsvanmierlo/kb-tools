import { parseHistoricalDateToDays, assignTimelineLanes, formatEpochDaysToLabel } from './canvas-renderer.js';
import { Sanitizer } from '../../core/sanitizer.js';

/**
 * Standalone Vector SVG Serializer & Timeline Exporter (KB-TIME-002)
 */
export class TimelineSVGExporter {
  /**
   * Escape XML entities
   */
  static escapeXml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Generate standalone XML SVG string from timeline dataset
   * @param {object} dataset - { title, events: [...] }
   * @param {number} [width=1200]
   * @param {number} [height=700]
   * @returns {string} XML SVG string
   */
  static generateSVGString(dataset, width = 1200, height = 700) {
    const events = dataset.events || [];
    if (events.length === 0) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <style>text { font-family: system-ui, -apple-system, sans-serif; }</style>
  <rect width="${width}" height="${height}" fill="#f8fafc"/>
  <text x="${width / 2}" y="${height / 2}" font-size="16" fill="#64748b" text-anchor="middle">Empty Timeline</text>
</svg>`;
    }

    // Calculate temporal range
    const days = events.map(e => parseHistoricalDateToDays(e.start_date));
    const minDay = Math.min(...days);
    const maxDay = Math.max(...days);
    const spanDays = Math.max(30, maxDay - minDay);
    const paddingX = 80;
    const usableWidth = width - paddingX * 2;
    const pixelsPerDay = usableWidth / spanDays;

    const dayToX = (d) => paddingX + (d - minDay) * pixelsPerDay;

    // Run collision & lane packing solver
    const { items, totalLanes } = assignTimelineLanes(events, dayToX, 24);

    const axisY = 90;
    const lanesStartY = 140;
    const laneHeight = 44;
    const dynamicHeight = Math.max(height, lanesStartY + totalLanes * laneHeight + 60);

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${dynamicHeight}" width="${width}" height="${dynamicHeight}">
  <defs>
    <style>
      .title { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 20px; font-weight: bold; fill: #0f172a; }
      .subtitle { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; fill: #64748b; }
      .axis-tick { stroke: #64748b; stroke-width: 1.5; }
      .gridline { stroke: #e2e8f0; stroke-width: 1; stroke-dasharray: 2 2; }
      .axis-label { font-family: system-ui, -apple-system, sans-serif; font-size: 11px; fill: #64748b; text-anchor: middle; }
      .event-text { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 500; }
      .connector { stroke-width: 1; stroke-dasharray: 2 2; }
    </style>
  </defs>

  <!-- Background Canvas -->
  <rect width="${width}" height="${dynamicHeight}" fill="#f8fafc"/>

  <!-- Header -->
  <text x="${paddingX}" y="42" class="title">${this.escapeXml(dataset.title || 'Interactive Timeline')}</text>
  <text x="${paddingX}" y="62" class="subtitle">Exported from KennisBoost Tools • ${events.length} Historical Event(s)</text>

  <!-- Temporal Axis Line -->
  <line x1="${paddingX - 20}" y1="${axisY}" x2="${width - paddingX + 20}" y2="${axisY}" stroke="#94a3b8" stroke-width="2"/>
`;

    // Render 6-8 interval ticks along axis
    const tickCount = 7;
    const tickStepDays = spanDays / (tickCount - 1);
    for (let i = 0; i < tickCount; i++) {
      const d = minDay + i * tickStepDays;
      const x = dayToX(d);
      const label = formatEpochDaysToLabel(d, spanDays > 365.25 * 50 ? 'decade' : 'year');

      svg += `  <line x1="${x}" y1="${axisY}" x2="${x}" y2="${dynamicHeight - 30}" class="gridline"/>\n`;
      svg += `  <line x1="${x}" y1="${axisY - 6}" x2="${x}" y2="${axisY + 6}" class="axis-tick"/>\n`;
      svg += `  <text x="${x}" y="${axisY - 12}" class="axis-label">${this.escapeXml(label)}</text>\n`;
    }

    // Render Event Items
    for (const item of items) {
      const laneY = lanesStartY + item.lane * laneHeight;
      const cardHeight = 28;
      const cardWidth = Math.max(130, item.xEnd - item.xStart);
      const color = Sanitizer.safeColor(item.color, '#3b82f6');

      // Stem connector
      svg += `  <line x1="${item.xStart}" y1="${axisY}" x2="${item.xStart}" y2="${laneY}" stroke="${color}" class="connector"/>\n`;
      // Milestone dot on axis
      svg += `  <circle cx="${item.xStart}" cy="${axisY}" r="4" fill="${color}"/>\n`;

      // Event Card Bar / Pill
      if (item.isSpan) {
        svg += `  <rect x="${item.xStart}" y="${laneY}" width="${cardWidth}" height="${cardHeight}" rx="6" fill="${color}" stroke="${color}" stroke-width="1.5"/>\n`;
        svg += `  <text x="${item.xStart + 8}" y="${laneY + 18}" class="event-text" fill="#ffffff">${this.escapeXml(item.title)}</text>\n`;
      } else {
        svg += `  <rect x="${item.xStart}" y="${laneY}" width="${cardWidth}" height="${cardHeight}" rx="6" fill="#ffffff" stroke="${color}" stroke-width="1.5"/>\n`;
        svg += `  <text x="${item.xStart + 8}" y="${laneY + 18}" class="event-text" fill="#0f172a">${this.escapeXml(item.title)}</text>\n`;
      }
    }

    svg += `</svg>`;
    return svg;
  }

  /**
   * Trigger download of SVG file
   */
  static downloadSVG(dataset, filename = 'timeline_export.svg') {
    if (typeof document === 'undefined') return;
    const svgStr = this.generateSVGString(dataset);
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 100);
  }
}

export default TimelineSVGExporter;
