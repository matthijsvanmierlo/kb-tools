/**
 * Name parsing, formatting, and sorting helpers.
 * Handles "Last, First", "First Middle Last", and surname particles.
 */

const PARTICLES = new Set([
  'van', 'van der', 'van den', 'van de', 'de', 'den', 'der',
  'von', 'da', 'del', 'di', 'la', 'le', 'du', 'ter', 'ten',
  'della', 'des'
]);

/**
 * Split a full name into given and family names.
 * @param {string} full
 * @returns {{ given: string, family: string }}
 */
export function splitName(full) {
  if (!full || typeof full !== 'string') {
    return { given: '', family: '' };
  }

  const trimmed = full.trim();
  if (!trimmed) {
    return { given: '', family: '' };
  }

  // Handle "Last, First"
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',');
    const family = parts[0].trim();
    const given = parts.slice(1).join(',').trim();
    return { given, family };
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    return { given: tokens[0], family: '' };
  }

  // Check for particles from token index 1 onwards
  for (let i = 1; i < tokens.length - 1; i++) {
    // Check two-word particle first (e.g. "van der", "van den", "van de")
    if (i < tokens.length - 2) {
      const twoWords = `${tokens[i]} ${tokens[i + 1]}`.toLowerCase();
      if (PARTICLES.has(twoWords)) {
        return {
          given: tokens.slice(0, i).join(' '),
          family: tokens.slice(i).join(' ')
        };
      }
    }
    const singleWord = tokens[i].toLowerCase();
    if (PARTICLES.has(singleWord)) {
      return {
        given: tokens.slice(0, i).join(' '),
        family: tokens.slice(i).join(' ')
      };
    }
  }

  // Default: last token is family, preceding are given
  return {
    given: tokens.slice(0, -1).join(' '),
    family: tokens[tokens.length - 1]
  };
}

/**
 * Join given and family names into a single string.
 * Supports both joinName({ given, family }) and joinName(given, family).
 * @param {object|string} firstArg
 * @param {string} [secondArg]
 * @returns {string}
 */
export function joinName(firstArg, secondArg) {
  if (firstArg && typeof firstArg === 'object') {
    const g = (firstArg.given || firstArg.given_name || '').trim();
    const f = (firstArg.family || firstArg.family_name || '').trim();
    if (g && f) return `${g} ${f}`;
    return g || f || '';
  }
  const g = String(firstArg || '').trim();
  const f = String(secondArg || '').trim();
  if (g && f) return `${g} ${f}`;
  return g || f || '';
}

/**
 * Generate a sort key for a student record or name string.
 * @param {object|string} student
 * @returns {string}
 */
export function sortKey(student) {
  if (!student) return '';
  if (typeof student === 'string') {
    const { given, family } = splitName(student);
    return `${family.toLowerCase()} ${given.toLowerCase()}`.trim();
  }
  const family = student.family_name || splitName(student.full_name || '').family || '';
  const given = student.given_name || splitName(student.full_name || '').given || '';
  return `${family.toLowerCase()} ${given.toLowerCase()}`.trim();
}
