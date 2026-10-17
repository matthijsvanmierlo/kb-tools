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
 * @returns {{ mode: 'traditional'|'sbg', score: number|null, letter: string, mastery: number|null, standards: Map|null }}
 */
export function computeStudentSummary(student, course, assignments, gradesMap) {
  const records = new Map();
  for (const a of assignments) {
    const rec = gradesMap.get(`${student.student_id}+${a.id}`);
    if (rec) records.set(a.id, rec);
  }

  if (course.grading_scale === 'sbg') {
    const standards = computeStudentStandards(student.student_id, course, assignments, gradesMap);
    let mastery = computeOverallMastery(standards);

    // Classes without a standards list: use proficiency-scored work as general evidence
    if (mastery === null && getStandards(course).length === 0) {
      const ordered = [...assignments]
        .filter(a => a.scoring === 'proficiency')
        .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
      const scores = ordered
        .map(a => records.get(a.id))
        .filter(r => r && r.status !== 'exempt' && r.raw_score !== null && r.raw_score !== undefined)
        .map(r => Number(r.raw_score));
      mastery = computeStandardMastery(scores, course);
    }

    if (mastery !== null) {
      const grade = masteryToGrade(mastery, course);
      return { mode: 'sbg', score: grade.percent, letter: grade.letter, mastery, standards };
    }
  }

  const pct = GradebookMathEngine.computeTraditionalWeighted(records, assignments, course.categories || []);
  return {
    mode: course.grading_scale === 'sbg' ? 'sbg' : 'traditional',
    score: pct,
    letter: letterForPercent(pct, course),
    mastery: null,
    standards: course.grading_scale === 'sbg' ? computeStudentStandards(student.student_id, course, assignments, gradesMap) : null
  };
}

export function computeCourseAggregates(students, course, assignments, gradesMap) {
  const out = new Map();
  for (const s of students) out.set(s.student_id, computeStudentSummary(s, course, assignments, gradesMap));
  return out;
}
