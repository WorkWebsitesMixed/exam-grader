/**
 * goals.js -- the department's learning goals per grade and term.
 *
 * Role: copied once from the "Proficiency Levels" workbook of the Design &
 * Technology department (tabs 10 and 11, column "Goal"). The school expects the
 * same general goal on every assessment of a term, so an exam only needs its
 * grade and term: the exam header looks the sentence up here. An exam can still
 * override it (exams.goals_override). Grade 12 is empty on purpose: its tab in
 * the workbook is the old ICT course, not IGCSE 0445; it stays editable per exam.
 *
 * Not read from the workbook at run time: the Worker cannot reach it and the
 * goals change about once a year. To update, edit this file.
 */

export const LEARNING_GOALS = {
  '10': {
    I: 'Produces professional annotated design drawings and a justified specification, completes understanding of crank and cam mechanisms and Electronics I–III, and builds and tests a working electronic circuit.',
    II: 'Classifies all five material families by their mechanical and physical properties, explains the effects of heat treatment on material structure, identifies smart and composite materials for specific applications, and selects and justifies materials and making processes for a design context.',
    III: 'Analyses commercial manufacturing processes and existing products using ACCESSFM, applies sustainability and lifecycle thinking, completes a full iterative design-and-make project using Materials option knowledge, and practises Paper 1 and Paper 3 exam technique.',
  },
  '11': {
    I: 'Launches the Component 2 coursework project — C1 brief and C2 specification — applies structures and materials knowledge to Paper 4 exam-style questions, draws and tests the required low-voltage light circuit, and develops Paper 1 design-communication skills.',
    II: 'Completes the design phase of Component 2 — C3 idea selection, C4 development with modelling and testing, C5 working drawings and production plan — applies CAD/CAM tools, and demonstrates Paper 1 exam technique across all 7 parts.',
    III: 'Manufactures, assembles and finishes the Component 2 product (C6), objectively tests and evaluates it against the specification (C7), and submits a complete, evidence-rich C1–C7 folder for Cambridge assessment.',
  },
};

/** The goal sentence for a grade ('10') and term ('I'), or '' when there is none. */
export function goalFor(grade, term) {
  const g = LEARNING_GOALS[String(grade)];
  return (g && g[String(term)]) || '';
}
