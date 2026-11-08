/**
 * header.js -- the exam header required by the school's written-exam format.
 *
 * Role: turns an exams row into the plain strings the pages print (school,
 * title, grade, term, teacher, directions, learning goals). The student pages
 * and the results email both use it, so the wording lives in one place.
 * Everything is English on purpose: the subject is taught in English.
 */

import { goalFor } from './goals.js';

export const SCHOOL_NAME = 'Marymount School - Medellín';

// Shown when an exam has no directions of its own. The first sentence is the
// school's wording; the others restate rules the exam page already enforces.
export const DEFAULT_DIRECTIONS =
  'Keep only the exam page open on the computer. No other tabs, windows or programs are allowed ' +
  'during the exam, except resources expressly authorised by the teacher.\n' +
  'Read each question carefully: the marks available are shown next to it.\n' +
  'Work on your own. Copying, pasting and sharing answers are not allowed and are recorded.\n' +
  'When the time ends, your answers are submitted automatically.';

/** "10" -> "10th Grade" (every grade we use ends in th). */
function gradeLabel(g) { return g ? g + 'th Grade' : ''; }

/**
 * @param {object} exam  exams row
 * @param {number} now   epoch ms (supplies the year when term_year is empty)
 */
export function examHeader(exam, now) {
  const year = exam.term_year || new Date(now).getUTCFullYear();
  return {
    school: SCHOOL_NAME,
    title: exam.title,
    grade: gradeLabel(exam.grade_level),
    term: exam.term ? 'Term ' + exam.term + ' – ' + year : '',
    teacher: exam.teacher || '',
    directions: exam.directions || DEFAULT_DIRECTIONS,
    goals: exam.goals_override || goalFor(exam.grade_level, exam.term),
  };
}
