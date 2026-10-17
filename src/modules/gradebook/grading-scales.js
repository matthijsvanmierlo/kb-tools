import { GradebookMathEngine } from './engine-calc.js';

/**
 * Grading Scales & Standards-Based Grading configuration (KB-GRAD-005)
 *
 * Every course (class section) carries its own:
 *  - `letter_scale`: percentage → letter bands for traditional grading
 *  - `sbg`: proficiency levels, mastery calculation method, and mastery → letter/percent conversion
 *  - `standards`: the learning standards assignments are aligned to
 *
 * Older courses without these fields fall back to the defaults below, which match the
 * behaviour of the original hard-coded engine.
 */

export const LETTER_SCALE_PRESETS = {
  us_plus_minus: {
    name: 'Standard A–F with +/−',
    bands: [
      { label: 'A', min: 93 }, { label: 'A-', min: 90 },
      { label: 'B+', min: 87 }, { label: 'B', min: 83 }, { label: 'B-', min: 80 },
      { label: 'C+', min: 77 }, { label: 'C', min: 73 }, { label: 'C-', min: 70 },
      { label: 'D+', min: 67 }, { label: 'D', min: 60 },
      { label: 'F', min: 0 }
    ]
  },
  us_simple: {
    name: 'Simple A–F (90/80/70/60)',
    bands: [
      { label: 'A', min: 90 }, { label: 'B', min: 80 }, { label: 'C', min: 70 },
      { label: 'D', min: 60 }, { label: 'F', min: 0 }
    ]
  },
  pass_fail: {
    name: 'Pass / Fail',
    bands: [{ label: 'P', min: 60 }, { label: 'F', min: 0 }]
  },
  ib_1_7: {
    name: 'IB-style 1–7',
    bands: [
      { label: '7', min: 85 }, { label: '6', min: 72 }, { label: '5', min: 60 },
      { label: '4', min: 48 }, { label: '3', min: 36 }, { label: '2', min: 20 }, { label: '1', min: 0 }
    ]
  },
  nl_1_10: {
    name: 'Dutch 1–10 (5.5 to pass)',
    bands: [
      { label: '10', min: 95 }, { label: '9', min: 85 }, { label: '8', min: 75 },
      { label: '7', min: 65 }, { label: '6', min: 55 }, { label: '5', min: 45 },
      { label: '4', min: 35 }, { label: '3', min: 25 }, { label: '2', min: 10 }, { label: '1', min: 0 }
    ]
  }
};

export const SBG_CALCULATION_METHODS = {
  power_law: { name: 'Power law (Marzano trend)', help: 'Fits a learning curve and reports the predicted current level. Rewards growth; needs 3+ scores to be meaningful.' },
  decaying_average: { name: 'Decaying average', help: 'Each new score counts more than older ones (weight set below).' },
  most_recent: { name: 'Most recent', help: 'The latest evidence replaces earlier scores.' },
  highest: { name: 'Highest score', help: 'The best demonstrated level counts.' },
  mode: { name: 'Mode (most frequent)', help: 'The most common level, ties go to the most recent.' },
  mean: { name: 'Mean', help: 'Simple average of all scores.' }
};

export const DEFAULT_PROFICIENCY_LEVELS = [
  { value: 4, label: 'Exceeds', description: 'Applies the skill in new or complex situations beyond what was taught.', color: '#059669' },
  { value: 3, label: 'Meets', description: 'Independently demonstrates the full standard.', color: '#2563eb' },
  { value: 2, label: 'Approaching', description: 'Demonstrates the simpler parts of the standard; needs support with complex parts.', color: '#d97706' },
  { value: 1, label: 'Beginning', description: 'Demonstrates partial understanding with help.', color: '#e11d48' },
  { value: 0, label: 'No evidence', description: 'Not enough evidence yet to assess.', color: '#64748b' }
];

export const DEFAULT_MASTERY_BANDS = [
  { min: 3.5, letter: 'A', percent: 95 },
  { min: 3.0, letter: 'B+', percent: 88 },
  { min: 2.5, letter: 'B-', percent: 82 },
  { min: 2.0, letter: 'C', percent: 75 },
  { min: 1.5, letter: 'D', percent: 65 },
  { min: 0, letter: 'F', percent: 55 }
];

export const DEFAULT_SBG_CONFIG = {
  levels: DEFAULT_PROFICIENCY_LEVELS,
  calculation: 'power_law',
  decay_weight: 0.65,
  mastery_bands: DEFAULT_MASTERY_BANDS
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Letter scale for a course, falling back to the original +/- scale */
export function getLetterScale(course) {
  const scale = course?.letter_scale;
  if (scale && Array.isArray(scale.bands) && scale.bands.length > 0) return scale;
  return { preset: 'us_plus_minus', bands: clone(LETTER_SCALE_PRESETS.us_plus_minus.bands) };
}

export function getSbgConfig(course) {
  const cfg = course?.sbg || {};
  return {
    levels: Array.isArray(cfg.levels) && cfg.levels.length ? cfg.levels : clone(DEFAULT_PROFICIENCY_LEVELS),
    calculation: SBG_CALCULATION_METHODS[cfg.calculation] ? cfg.calculation : DEFAULT_SBG_CONFIG.calculation,
    decay_weight: typeof cfg.decay_weight === 'number' ? cfg.decay_weight : DEFAULT_SBG_CONFIG.decay_weight,
    mastery_bands: Array.isArray(cfg.mastery_bands) && cfg.mastery_bands.length ? cfg.mastery_bands : clone(DEFAULT_MASTERY_BANDS)
  };
}

export function getStandards(course) {
  return Array.isArray(course?.standards) ? course.standards : [];
}

/** Highest proficiency value on the course's scale (usually 4) */
export function getMaxLevel(course) {
  return Math.max(...getSbgConfig(course).levels.map(l => Number(l.value) || 0), 1);
}

export function levelInfo(course, value) {
  if (value === null || value === undefined || value === '') return null;
  const levels = getSbgConfig(course).levels;
  const exact = levels.find(l => Number(l.value) === Number(value));
  if (exact) return exact;
  // Fractional mastery (e.g. 2.7): use the nearest level at or below for colour/label
  const sorted = [...levels].sort((a, b) => b.value - a.value);
  return sorted.find(l => Number(value) >= Number(l.value)) || sorted[sorted.length - 1];
}

/**
 * Percentage → letter using a course's scale. Accepts a course or a bands array.
 */
export function letterForPercent(pct, courseOrBands) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return 'N/A';
  const bands = Array.isArray(courseOrBands) ? courseOrBands : getLetterScale(courseOrBands).bands;
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  const match = sorted.find(b => pct >= b.min);
  return match ? match.label : sorted[sorted.length - 1]?.label || 'N/A';
}

/**
 * Mastery (on the proficiency scale) → { letter, percent } using the course's conversion table.
 */
export function masteryToGrade(mastery, course) {
  if (mastery === null || mastery === undefined || Number.isNaN(mastery)) return { percent: null, letter: 'N/A' };
  const bands = [...getSbgConfig(course).mastery_bands].sort((a, b) => b.min - a.min);
  const match = bands.find(b => mastery >= b.min) || bands[bands.length - 1];
  return { percent: match.percent, letter: match.letter };
}

/**
 * Current mastery for one standard from chronological evidence, per the course's method.
 */
export function computeStandardMastery(chronologicalScores, course) {
  const scores = (chronologicalScores || []).filter(s => s !== null && s !== undefined && !Number.isNaN(Number(s))).map(Number);
  if (scores.length === 0) return null;
  const cfg = getSbgConfig(course);
  const maxLevel = getMaxLevel(course);
  let result;
  switch (cfg.calculation) {
    case 'decaying_average':
      result = GradebookMathEngine.computeDecayingAverage(scores, cfg.decay_weight);
      break;
    case 'most_recent':
      result = scores[scores.length - 1];
      break;
    case 'highest':
      result = GradebookMathEngine.computeHighestScore(scores);
      break;
    case 'mode':
      result = GradebookMathEngine.computeTrendMode(scores);
      break;
    case 'mean':
      result = scores.reduce((a, b) => a + b, 0) / scores.length;
      break;
    case 'power_law':
    default:
      result = GradebookMathEngine.computeMarzanoPowerLaw(scores);
  }
  return Number(Math.min(maxLevel, Math.max(0, result)).toFixed(2));
}

/**
 * Standards evidence for one student, ordered by assignment due date.
 * Each grade record may carry `standard_scores: { [standardId]: level }`. For assignments aligned
 * to a single standard, a plain raw_score entered in SBG mode counts as that standard's level.
 *
 * @returns {Map<string, { scores: number[], mastery: number|null, evidence: Array }>}
 */
export function computeStudentStandards(studentId, course, assignments, gradesMap) {
  const standards = getStandards(course);
  const result = new Map(standards.map(s => [s.id, { scores: [], mastery: null, evidence: [] }]));
  const ordered = [...assignments].sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

  for (const a of ordered) {
    const rec = gradesMap.get(`${studentId}+${a.id}`);
    if (!rec || rec.status === 'exempt') continue;
    const aligned = Array.isArray(a.standard_ids) ? a.standard_ids : [];
    const perStandard = { ...(rec.standard_scores || {}) };
    if (aligned.length === 1 && perStandard[aligned[0]] === undefined && rec.raw_score !== null && rec.raw_score !== undefined && a.scoring === 'proficiency') {
      perStandard[aligned[0]] = rec.raw_score;
    }
    for (const [stdId, level] of Object.entries(perStandard)) {
      if (level === null || level === undefined || level === '') continue;
      const bucket = result.get(stdId);
      if (!bucket) continue;
      bucket.scores.push(Number(level));
      bucket.evidence.push({ assignment_id: a.id, title: a.title, level: Number(level), date: a.due_date });
    }
  }

  for (const bucket of result.values()) {
    bucket.mastery = computeStandardMastery(bucket.scores, course);
  }
  return result;
}

/**
 * Overall SBG grade: mean of current mastery across standards with evidence.
 */
export function computeOverallMastery(standardsMap) {
  const values = [...standardsMap.values()].map(b => b.mastery).filter(m => m !== null);
  if (values.length === 0) return null;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
}

// -----------------------------------------------------------------------------
// Standard set presets (official statement text, retrieved from the CASE network)
// -----------------------------------------------------------------------------

export const STANDARD_SET_PRESETS = [
  {
    key: 'ngss-hs-ps1',
    name: 'NGSS HS-PS1: Matter and Its Interactions',
    subject: 'Science (Chemistry)',
    standards: [
      { code: 'HS-PS1-1', description: 'Use the periodic table as a model to predict the relative properties of elements based on the patterns of electrons in the outermost energy level of atoms.' },
      { code: 'HS-PS1-2', description: 'Construct and revise an explanation for the outcome of a simple chemical reaction based on the outermost electron states of atoms, trends in the periodic table, and knowledge of the patterns of chemical properties.' },
      { code: 'HS-PS1-3', description: 'Plan and conduct an investigation to gather evidence to compare the structure of substances at the bulk scale to infer the strength of electrical forces between particles.' },
      { code: 'HS-PS1-4', description: 'Develop a model to illustrate that the release or absorption of energy from a chemical reaction system depends upon the changes in total bond energy.' },
      { code: 'HS-PS1-5', description: 'Apply scientific principles and evidence to provide an explanation about the effects of changing the temperature or concentration of the reacting particles on the rate at which a reaction occurs.' },
      { code: 'HS-PS1-6', description: 'Refine the design of a chemical system by specifying a change in conditions that would produce increased amounts of products at equilibrium.' },
      { code: 'HS-PS1-7', description: 'Use mathematical representations to support the claim that atoms, and therefore mass, are conserved during a chemical reaction.' },
      { code: 'HS-PS1-8', description: 'Develop models to illustrate the changes in the composition of the nucleus of the atom and the energy released during the processes of fission, fusion, and radioactive decay.' }
    ]
  },
  {
    key: 'ccss-hsf-if',
    name: 'Common Core HSF-IF: Interpreting Functions',
    subject: 'Mathematics',
    standards: [
      { code: 'HSF-IF.A.1', description: 'Understand that a function from one set (called the domain) to another set (called the range) assigns to each element of the domain exactly one element of the range. If f is a function and x is an element of its domain, then f(x) denotes the output of f corresponding to the input x. The graph of f is the graph of the equation y = f(x).' },
      { code: 'HSF-IF.A.2', description: 'Use function notation, evaluate functions for inputs in their domains, and interpret statements that use function notation in terms of a context.' },
      { code: 'HSF-IF.A.3', description: 'Recognize that sequences are functions, sometimes defined recursively, whose domain is a subset of the integers.' },
      { code: 'HSF-IF.B.4', description: 'For a function that models a relationship between two quantities, interpret key features of graphs and tables in terms of the quantities, and sketch graphs showing key features given a verbal description of the relationship.' },
      { code: 'HSF-IF.B.5', description: 'Relate the domain of a function to its graph and, where applicable, to the quantitative relationship it describes.' },
      { code: 'HSF-IF.B.6', description: 'Calculate and interpret the average rate of change of a function (presented symbolically or as a table) over a specified interval. Estimate the rate of change from a graph.' },
      { code: 'HSF-IF.C.7', description: 'Graph functions expressed symbolically and show key features of the graph, by hand in simple cases and using technology for more complicated cases.' },
      { code: 'HSF-IF.C.8', description: 'Write a function defined by an expression in different but equivalent forms to reveal and explain different properties of the function.' },
      { code: 'HSF-IF.C.9', description: 'Compare properties of two functions each represented in a different way (algebraically, graphically, numerically in tables, or by verbal descriptions).' }
    ]
  }
];

/**
 * Parse pasted or CSV standards. Accepts "CODE, description", "CODE<tab>description",
 * "CODE: description" or "CODE - description" per line; an optional header row is skipped.
 * Quoted CSV fields are supported.
 */
export function parseStandardsText(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    let code = '';
    let description = '';
    const csv = line.match(/^"?([^",\t]+?)"?\s*[,\t]\s*"?(.*?)"?$/);
    const colon = line.match(/^([A-Za-z0-9][\w.\-]*)\s*(?::|\s-\s|\s–\s)\s*(.+)$/);
    if (csv && csv[2]) {
      code = csv[1].trim();
      description = csv[2].replace(/""/g, '"').trim();
    } else if (colon) {
      code = colon[1].trim();
      description = colon[2].trim();
    } else {
      continue;
    }
    if (/^(code|standard|id)$/i.test(code)) continue; // header row
    if (code && description) out.push({ code, description });
  }
  return out;
}

/** Keep legacy callers working: same signature as GradebookMathEngine.percentageToLetter */
export function defaultLetterForPercent(pct) {
  return letterForPercent(pct, LETTER_SCALE_PRESETS.us_plus_minus.bands);
}
