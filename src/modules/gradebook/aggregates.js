import { GradebookMathEngine } from './engine-calc.js';
import {
  computeStudentStandards,
  computeOverallMastery,
  computeStandardMastery,
  masteryToGrade,
  letterForPercent,
  getStandards
} from './grading-scales.js';

/**
 * Per-student course summary used by the grid, the standards view, PDF reports and the
 * student's encrypted grade report, so every surface shows the same numbers.
 *
 * @returns {{ mode: 'traditional'|'sbg'|'hybrid', score: number|null, letter: string, mastery: number|null, standards: Map|null }}
 */
export function computeStudentSummary(student, course, assignments, gradesMap) {
  const records = new Map();
  for (const a of assignments) {
    const rec = gradesMap.get(`${student.student_id}+${a.id}`);
    if (rec) records.set(a.id, rec);
  }

  const hasStandards = getStandards(course).length > 0;
  const mode = course.grading_scale === 'sbg'
    ? 'sbg'
    : course.grading_scale === 'hybrid'
      ? 'hybrid'
      : 'traditional';

  const standards = (mode === 'sbg' || mode === 'hybrid' || hasStandards)
    ? computeStudentStandards(student.student_id, course, assignments, gradesMap)
    : null;

  let mastery = standards ? computeOverallMastery(standards) : null;
  // Classes without a standards list: use proficiency-scored work as general evidence
  if (mastery === null && (mode === 'sbg' || mode === 'hybrid') && !hasStandards) {
    const ordered = [...assignments]
      .filter(a => a.scoring === 'proficiency')
      .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    const scores = ordered
      .map(a => records.get(a.id))
      .filter(r => r && r.status !== 'exempt' && r.raw_score !== null && r.raw_score !== undefined)
      .map(r => Number(r.raw_score));
    mastery = computeStandardMastery(scores, course);
  }

  if (mode === 'sbg' && mastery !== null) {
    const grade = masteryToGrade(mastery, course);
    return { mode: 'sbg', score: grade.percent, letter: grade.letter, mastery, standards };
  }

  const pct = GradebookMathEngine.computeTraditionalWeighted(records, assignments, course.categories || []);

  if (mode === 'hybrid') {
    const stdWeight = Math.min(100, Math.max(0, Number(course.sbg_config?.hybrid_standards_weight_pct ?? 50)));
    if (mastery !== null) {
      const stdGrade = masteryToGrade(mastery, course);
      let finalPct = pct;
      if (stdWeight > 0) {
        if (pct !== null && stdGrade.percent !== null) {
          finalPct = Math.round(((pct * (100 - stdWeight) + stdGrade.percent * stdWeight) / 100) * 10) / 10;
        } else if (stdGrade.percent !== null) {
          finalPct = stdGrade.percent;
        }
      }
      return {
        mode: 'hybrid',
        score: finalPct,
        letter: letterForPercent(finalPct, course),
        mastery,
        standards,
        points_score: pct,
        standards_percent: stdGrade.percent
      };
    }
    return {
      mode: 'hybrid',
      score: pct,
      letter: letterForPercent(pct, course),
      mastery: null,
      standards,
      points_score: pct,
      standards_percent: null
    };
  }

  return {
    mode,
    score: pct,
    letter: letterForPercent(pct, course),
    mastery,
    standards
  };
}

export function computeCourseAggregates(students, course, assignments, gradesMap) {
  const out = new Map();
  for (const s of students) out.set(s.student_id, computeStudentSummary(s, course, assignments, gradesMap));
  return out;
}
