import papaLib from 'papaparse';

const Papa = papaLib.parse ? papaLib : (papaLib.default || papaLib);

/**
 * Suggest CSV delimiter based on user locale.
 * Semicolon for European/comma-decimal locales, comma elsewhere.
 * @returns {string} ',' or ';'
 */
export function suggestDelimiter() {
  const lang = (typeof navigator !== 'undefined'
    ? (navigator.languages?.[0] || navigator.language || 'en')
    : 'en').toLowerCase().slice(0, 2);

  const semicolonLocales = new Set([
    'nl', 'de', 'fr', 'es', 'it', 'pt', 'da', 'sv', 'fi', 'nb', 'pl', 'cs', 'tr'
  ]);

  return semicolonLocales.has(lang) ? ';' : ',';
}

/**
 * Guard against CSV injection vulnerabilities by prefixing dangerous characters with a single quote.
 * Formula triggers: = + - @ \t \r
 * @param {string} val
 * @returns {string}
 */
export function guardCell(val) {
  if (typeof val !== 'string') return val;
  if (/^[=+\-@\t\r]/.test(val)) {
    return `'${val}`;
  }
  return val;
}

/**
 * Format a single cell value for CSV output.
 * @param {any} val
 * @param {object} opts
 * @returns {string}
 */
function formatCell(val, opts = {}) {
  const { decimal = '.', guard = true } = opts;

  if (val === null || val === undefined) {
    return '""';
  }

  if (typeof val === 'boolean') {
    return `"${val ? 'Yes' : 'No'}"`;
  }

  if (typeof val === 'number') {
    let numStr = String(val);
    if (decimal === ',' && numStr.includes('.')) {
      numStr = numStr.replace('.', ',');
    }
    return `"${numStr}"`;
  }

  if (val instanceof Date) {
    return `"${val.toISOString()}"`;
  }

  let str = String(val);
  if (guard) {
    str = guardCell(str);
  }

  // Quote every text field, escape double quotes
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Convert an array of row objects to CSV string.
 * Uses UTF-8 BOM by default, CRLF line endings, quoted fields.
 * @param {Array<object>} rows
 * @param {Array<string|{ key: string, header?: string }>} [columns]
 * @param {object} [opts]
 * @param {boolean} [opts.bom=true]
 * @param {string} [opts.delimiter=',']
 * @param {string} [opts.decimal='.']
 * @param {string} [opts.lineEnding='\r\n']
 * @param {boolean} [opts.guard=true]
 * @returns {string}
 */
export function toCSV(rows = [], columns = null, opts = {}) {
  const {
    bom = true,
    delimiter = ',',
    decimal = '.',
    lineEnding = '\r\n',
    guard = true
  } = opts;

  if (!columns || columns.length === 0) {
    if (rows.length > 0) {
      columns = Object.keys(rows[0]);
    } else {
      columns = [];
    }
  }

  const colDefs = columns.map(col => {
    if (typeof col === 'string') {
      return { key: col, header: col };
    }
    return { key: col.key, header: col.header || col.key };
  });

  const lines = [];

  // Header line
  const headerLine = colDefs
    .map(c => `"${String(c.header).replace(/"/g, '""')}"`)
    .join(delimiter);
  lines.push(headerLine);

  // Row lines
  for (const row of rows) {
    const rowValues = colDefs.map(c => {
      let val = row[c.key];
      if (val === undefined && row[c.header] !== undefined) {
        val = row[c.header];
      }
      return formatCell(val, { decimal, guard });
    });
    lines.push(rowValues.join(delimiter));
  }

  const body = lines.join(lineEnding) + lineEnding;
  return bom ? `\uFEFF${body}` : body;
}

/**
 * Parse CSV text using PapaParse with safe defaults.
 * @param {string} text
 * @param {object} [opts]
 * @returns {{ fields: string[], rows: any[], errors: any[] }}
 */
export function parseCSV(text, opts = {}) {
  if (!text || typeof text !== 'string') {
    return { fields: [], rows: [], errors: [] };
  }

  const parsed = Papa.parse(text, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: 'greedy',
    transformHeader: h => (h ? h.trim() : ''),
    ...opts
  });

  return {
    fields: parsed.meta?.fields || [],
    rows: parsed.data || [],
    errors: parsed.errors || []
  };
}

/**
 * Trigger a browser file download of CSV content.
 * @param {string} filename
 * @param {string} text
 */
export function downloadCSV(filename, text) {
  if (typeof document === 'undefined') return;

  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename.endsWith('.csv') ? filename : `${filename}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
