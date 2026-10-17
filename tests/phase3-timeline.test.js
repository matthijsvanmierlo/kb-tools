import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseHistoricalDateToDays,
  assignTimelineLanes,
  formatEpochDaysToLabel
} from '../src/modules/timeline/canvas-renderer.js';
import { TimelineSVGExporter } from '../src/modules/timeline/svg-exporter.js';
import { parseCSVWithValidation, TimelineEventSchema } from '../src/core/validator.js';
import { generateUUID } from '../src/utils/uuid.js';

describe('Phase 3: Extended Astronomical Historical Date Parser', () => {
  it('parses BCE dates, ISO strings, and signed year integers with monotonic ordering', () => {
    const caesarBce = parseHistoricalDateToDays('-0044-03-15');
    const caesarYearInt = parseHistoricalDateToDays('-44');
    const luther = parseHistoricalDateToDays('1517-10-31');
    const thirtyYearsWar = parseHistoricalDateToDays('1618-05-23');
    const moonLanding = parseHistoricalDateToDays('1969-07-20');
    const modern = parseHistoricalDateToDays('2026-10-17');

    expect(caesarBce).toBeLessThan(luther);
    expect(luther).toBeLessThan(thirtyYearsWar);
    expect(thirtyYearsWar).toBeLessThan(moonLanding);
    expect(moonLanding).toBeLessThan(modern);

    // Caesar BCE date and -44 year integer should be very close (~within days in that year)
    expect(Math.abs(caesarBce - caesarYearInt)).toBeLessThan(366);
  });

  it('formats epoch days back into historical human labels at different resolutions', () => {
    const caesarDay = parseHistoricalDateToDays('-0044-03-15');
    expect(formatEpochDaysToLabel(caesarDay, 'century')).toContain('BCE');
    expect(formatEpochDaysToLabel(caesarDay, 'year')).toContain('44 BCE');

    const moonLandingDay = parseHistoricalDateToDays('1969-07-20');
    expect(formatEpochDaysToLabel(moonLandingDay, 'year')).toBe('1969');
    expect(formatEpochDaysToLabel(moonLandingDay, 'month')).toContain('1969');
  });
});

describe('Phase 3: Greedy Interval Partitioning (assignTimelineLanes)', () => {
  it('assigns overlapping milestones and duration spans into separate lanes with zero collision', () => {
    // 3 overlapping events occurring around the same time
    const events = [
      {
        id: 'ev-1',
        title: 'Event Alpha with Long Title',
        start_date: '1914-07-28',
        end_date: '1918-11-11',
        category: 'History',
        color: '#dc2626'
      },
      {
        id: 'ev-2',
        title: 'Event Beta (Overlapping Span)',
        start_date: '1916-01-01',
        end_date: '1917-12-31',
        category: 'History',
        color: '#2563eb'
      },
      {
        id: 'ev-3',
        title: 'Milestone Gamma (Overlapping Date)',
        start_date: '1916-07-01',
        end_date: null,
        category: 'History',
        color: '#059669'
      }
    ];

    // Dummy day-to-x projection function (1 pixel per day)
    const dayToX = (d) => d;
    const { items, totalLanes } = assignTimelineLanes(events, dayToX, 16);

    expect(items.length).toBe(3);
    // Since all 3 overlap concurrently on X screen coordinates, they must be partitioned into distinct lanes
    const lanes = items.map(it => it.lane);
    expect(new Set(lanes).size).toBe(3);
    expect(totalLanes).toBeGreaterThanOrEqual(3);
  });

  it('reuses previous lanes when events are non-overlapping with safe gap', () => {
    const events = [
      { id: 'ev-a', title: 'Ancient Event', start_date: '-0044-03-15', end_date: null },
      { id: 'ev-b', title: 'Modern Event', start_date: '2026-01-01', end_date: null }
    ];

    const dayToX = (d) => d * 0.01;
    const { items, totalLanes } = assignTimelineLanes(events, dayToX, 16);

    expect(items.length).toBe(2);
    // Because they are centuries apart, both can safely occupy lane 0
    expect(items[0].lane).toBe(0);
    expect(items[1].lane).toBe(0);
    expect(totalLanes).toBe(1);
  });
});

describe('Phase 3: Standalone Vector SVG Serializer', () => {
  it('generates valid standalone XML SVG with styling, axis, and event tags', () => {
    const dataset = {
      title: 'Renaissance Timeline & STEM',
      events: [
        {
          id: generateUUID(),
          title: 'Printing Press & Books',
          start_date: '1440-01-01',
          end_date: null,
          category: 'Technology',
          color: '#2563eb'
        },
        {
          id: generateUUID(),
          title: 'Italian Renaissance <High Period>',
          start_date: '1490-01-01',
          end_date: '1527-05-06',
          category: 'Art',
          color: '#d97706'
        }
      ]
    };

    const svg = TimelineSVGExporter.generateSVGString(dataset);

    expect(svg).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('Renaissance Timeline &amp; STEM'); // Escaped &
    expect(svg).toContain('Printing Press &amp; Books');
    expect(svg).toContain('&lt;High Period&gt;'); // Escaped < >
    expect(svg).toContain('<rect');
    expect(svg).toContain('<line');
    expect(svg).toContain('<circle');
    expect(svg).toContain('</svg>');
  });
});

describe('Phase 3: Timeline CSV Ingest Normalization', () => {
  it('normalizes omitted end_date as Milestone (end_date = null)', () => {
    const csvContent = `title,start_date,end_date,category,description\nMoon Landing,1969-07-20,,Space,First humans on the moon`;
    const res = parseCSVWithValidation(csvContent, TimelineEventSchema);

    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].title).toBe('Moon Landing');
    expect(res.data[0].end_date).toBeNull();
  });
});
