/**
 * paper.js -- decides WHICH questions, in WHAT order, with WHICH option order a
 * student gets, and what part of a question is safe to show.
 *
 * Role: this is getQuestionsResponse() from Code.gs split in two. The old code
 * did sampling and shuffling on every GET and sent the result; here it happens
 * once at /start and is STORED in attempts.paper, so grading later uses exactly
 * what this student was served.
 */

/** Fisher-Yates shuffle in place using an injectable random source. */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/**
 * Parses a question's JSON `options` column.
 */
function parseOptions(q) {
  try { return q.options ? JSON.parse(q.options) : []; } catch (e) { return []; }
}

/**
 * The student-safe view of a question. It never includes correct_index,
 * rubric or accepted_answers. Options are in PRINTED order; the per-student
 * display order comes separately from paper.optionOrder.
 */
export function publicQuestion(q) {
  const out = {
    id: q.qid,
    section: q.section,
    type: q.type,
    points: q.points,
    text: q.text,
    imageUrl: q.image_hash ? '/img/' + q.image_hash : '',
  };
  if (q.type === 'mc') { out.options = parseOptions(q); }
  return out;
}

/**
 * Builds a student's paper for one set.
 * @param {object} exam       exams row
 * @param {Array}  questions  questions rows of ONE set, ordered by position
 * @param {function} rng      random source, () => [0,1)
 * @returns {{qids: string[], optionOrder: Object<string, number[]>}}
 *   optionOrder[qid][k] = index (in printed order) of the option shown k-th.
 *
 * IGCSE mode is standardized: every question, fixed order, fixed option order,
 * and the sampling options are ignored. Standard mode follows the old rules:
 * `randomize` and `questions_per_set` are INDEPENDENT (never joined with AND),
 * and `oe_per_set` guarantees a number of non-MC questions.
 */
export function buildPaper(exam, questions, rng) {
  const igcse = exam.exam_type === 'igcse';
  let pool = questions.slice();

  const perSet = igcse ? 0 : exam.questions_per_set;
  const oePerSet = igcse ? 0 : exam.oe_per_set;
  const randomize = igcse ? false : !!exam.randomize;

  if (perSet > 0 && oePerSet > 0) {
    // Typed pools: draw the guaranteed open-ended count first, fill with MC.
    let mc = pool.filter((q) => q.type === 'mc');
    let oe = pool.filter((q) => q.type !== 'mc');
    if (randomize) { shuffle(mc, rng); shuffle(oe, rng); }
    const oeTake = Math.min(oePerSet, oe.length);
    const mcTake = Math.min(Math.max(0, perSet - oeTake), mc.length);
    pool = oe.slice(0, oeTake).concat(mc.slice(0, mcTake));
    if (randomize) { shuffle(pool, rng); }
  } else {
    if (randomize) { shuffle(pool, rng); }
    if (perSet > 0 && pool.length > perSet) { pool = pool.slice(0, perSet); }
  }

  const optionOrder = {};
  for (const q of pool) {
    if (q.type !== 'mc') { continue; }
    const order = parseOptions(q).map((_, i) => i);
    if (!igcse) { shuffle(order, rng); }
    optionOrder[q.qid] = order;
  }
  return { qids: pool.map((q) => q.qid), optionOrder };
}
