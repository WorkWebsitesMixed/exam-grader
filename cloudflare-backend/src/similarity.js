/**
 * similarity.js -- finds pairs of students whose answers are suspiciously alike.
 *
 * Role: a pure, deterministic text comparison. It does NOT call any AI model,
 * so it uses no tokens and costs nothing per run. Two signals:
 *
 *   1. Open-ended text: both answers are cut into 3-word phrases ("shingles");
 *      the overlap between the two sets (Jaccard) is the score. Phrases that
 *      already appear in the question text are ignored, because students
 *      legitimately repeat the wording of the question.
 *   2. Multiple choice: how many WRONG answers two students picked identically.
 *      Sharing a right answer says nothing; sharing several wrong ones does.
 *
 * A high score is a reason to LOOK at two papers, not proof of copying: two
 * students who studied the same notes can write similar sentences. The report
 * therefore ranks pairs and shows the shared phrases, and decides nothing.
 *
 * Used by the queue consumer (job 'similarity') and by tools/integrity-report.mjs.
 */

const MIN_WORDS = 25;          // shorter open answers are too thin to compare
const SHINGLE = 3;             // words per phrase
const OPEN_THRESHOLD = 0.5;    // Jaccard at or above this is flagged
const MIN_COMMON = 8;          // ...and at least this many shared phrases
const MC_MIN_SHARED = 3;       // shared wrong answers needed to flag
const MC_RATIO = 0.8;          // ...and at least this share of the smaller student's wrong answers
const MAX_PAIRS = 50;

/** Lower-case, accent-free, letters and digits only, single spaces. */
export function normalizeText(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Set of n-word phrases of a normalized text. */
function phrases(norm) {
  const words = norm ? norm.split(' ') : [];
  const out = new Set();
  for (let i = 0; i + SHINGLE <= words.length; i++) { out.add(words.slice(i, i + SHINGLE).join(' ')); }
  return out;
}

/** Compares two open answers. `ignore` is a Set of phrases to disregard (the question's own). */
export function compareOpen(textA, textB, ignore = new Set()) {
  const na = normalizeText(textA);
  const nb = normalizeText(textB);
  if (na.split(' ').length < MIN_WORDS || nb.split(' ').length < MIN_WORDS) { return null; }
  const a = phrases(na);
  const b = phrases(nb);
  for (const p of ignore) { a.delete(p); b.delete(p); }
  if (!a.size || !b.size) { return null; }
  const common = [];
  for (const p of a) { if (b.has(p)) { common.push(p); } }
  const union = a.size + b.size - common.length;
  return { score: common.length / union, common: common.length, phrases: common.slice(0, 4) };
}

/**
 * Builds the report for one exam.
 * @param {Array} attempts   [{id, email, first_name, last_name, class, set_id, answers, paper}]
 *                           `answers` / `paper` may be objects or JSON strings.
 * @param {Array} questions  question rows [{set_id, qid, type, text, correct_index}]
 */
export function buildSimilarityReport(attempts, questions) {
  const qmap = new Map(questions.map((q) => [q.set_id + '/' + q.qid, q]));
  const ignoreCache = new Map();
  const ignoreFor = (key, q) => {
    if (!ignoreCache.has(key)) { ignoreCache.set(key, phrases(normalizeText(q.text))); }
    return ignoreCache.get(key);
  };
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}));

  const people = attempts.map((a) => ({
    id: a.id, email: a.email, name: `${a.last_name}, ${a.first_name}`, class: a.class, set: a.set_id,
    answers: parse(a.answers), qids: parse(a.paper).qids || [],
  }));

  const pairs = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const A = people[i]; const B = people[j];
      if (A.set !== B.set) { continue; }               // different papers: not comparable
      const open = [];
      let sharedWrong = 0; let wrongA = 0; let wrongB = 0; let maxOpen = 0;

      for (const qid of A.qids) {
        if (!B.qids.includes(qid)) { continue; }
        const key = A.set + '/' + qid;
        const q = qmap.get(key);
        if (!q) { continue; }
        const ansA = A.answers[qid]; const ansB = B.answers[qid];
        if (q.type === 'mc') {
          const wa = Number.isInteger(ansA) && ansA !== q.correct_index;
          const wb = Number.isInteger(ansB) && ansB !== q.correct_index;
          if (wa) { wrongA++; }
          if (wb) { wrongB++; }
          if (wa && wb && ansA === ansB) { sharedWrong++; }
        } else if (q.type === 'openEnded') {
          const c = compareOpen(ansA, ansB, ignoreFor(key, q));
          if (c && c.score >= OPEN_THRESHOLD && c.common >= MIN_COMMON) {
            open.push({ qid, score: Math.round(c.score * 100) / 100, common: c.common, phrases: c.phrases });
            maxOpen = Math.max(maxOpen, c.score);
          }
        }
      }

      const minWrong = Math.min(wrongA, wrongB);
      const mcFlag = sharedWrong >= MC_MIN_SHARED && minWrong > 0 && sharedWrong >= MC_RATIO * minWrong;
      if (!open.length && !mcFlag) { continue; }
      pairs.push({
        set: A.set,
        a: { id: A.id, name: A.name, email: A.email, class: A.class },
        b: { id: B.id, name: B.name, email: B.email, class: B.class },
        open,
        mc: { sharedWrong, wrongA, wrongB, flagged: mcFlag },
        priority: open.length * 10 + Math.round(maxOpen * 5 * 100) / 100 + sharedWrong,
      });
    }
  }
  pairs.sort((x, y) => y.priority - x.priority);

  return {
    attemptsCompared: people.length,
    pairsFlagged: pairs.length,
    pairs: pairs.slice(0, MAX_PAIRS),
    thresholds: { openJaccard: OPEN_THRESHOLD, minCommonPhrases: MIN_COMMON, minWords: MIN_WORDS,
                  mcSharedWrong: MC_MIN_SHARED, mcRatio: MC_RATIO },
    note: 'A flagged pair is a reason to read both papers, not proof of copying.',
  };
}
