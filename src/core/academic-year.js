/**
 * Academic Year Utilities
 * Convention: August 1 to July 31
 * e.g., 2026-08-01 -> "2026-2027", 2027-03-01 -> "2026-2027"
 */

/**
 * Get default academic year string for a given date.
 * @param {Date} [date=new Date()]
 * @returns {string} e.g. "2026-2027"
 */
export function defaultAcademicYear(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth(); // 0-indexed: 7 is August

  if (month >= 7) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}
