/* The harness.
 *
 * For each case: build a fresh database, run the gold query, admit or refuse
 * the prediction, run it, compare the result sets, and classify the outcome.
 * The exact-match baseline is computed alongside on the same cases, so the two
 * metrics are always measured on identical input.
 */

import { openDatabase, runQuery } from './execute.js';
import { checkSafe, stripLiterals } from './guard.js';
import { compareResults, isOrdered } from './compare.js';
import { exactMatch } from './normalize.js';

/** Why a prediction failed. One label per case, mutually exclusive. */
export const OUTCOMES = {
  correct: 'Result set matches the gold query',
  blocked_unsafe: 'Refused before execution: not a single read-only query',
  syntax_error: 'The database rejected the prediction',
  wrong_column_count: 'Returned a different number of columns',
  missing_rows: 'Returned fewer rows than the gold query',
  extra_rows: 'Returned rows the gold query does not',
  wrong_order: 'Right rows, wrong sequence, on an ordered question',
  wrong_values: 'Same shape, different values',
  gold_failed: 'The gold query itself did not run — a broken benchmark case',
};

/**
 * @param {{ddl: string, cases: Array}} suite
 * @param {{numericStrings?: boolean, maxRows?: number}} opts
 */
export function evaluate(suite, opts = {}) {
  const results = [];

  for (const c of suite.cases) {
    const db = openDatabase(suite.ddl);           // fresh per case
    try {
      const gold = runQuery(db, c.gold, opts);
      if (!gold.ok) {
        results.push({
          id: c.id, question: c.question, gold: c.gold, prediction: c.prediction,
          outcome: 'gold_failed', detail: { error: gold.error },
          execCorrect: false, exactCorrect: false, ordered: false,
        });
        continue;
      }

      const ordered = isOrdered(c.gold, stripLiterals);
      const exactCorrect = exactMatch(c.gold, c.prediction);

      const safe = checkSafe(c.prediction);
      if (!safe.ok) {
        results.push({
          id: c.id, question: c.question, gold: c.gold, prediction: c.prediction,
          outcome: 'blocked_unsafe', detail: { reason: safe.reason },
          execCorrect: false, exactCorrect, ordered,
        });
        continue;
      }

      const pred = runQuery(db, c.prediction, opts);
      if (!pred.ok) {
        results.push({
          id: c.id, question: c.question, gold: c.gold, prediction: c.prediction,
          outcome: 'syntax_error', detail: { error: pred.error },
          execCorrect: false, exactCorrect, ordered,
        });
        continue;
      }

      const cmp = compareResults(gold, pred, { ordered, numericStrings: opts.numericStrings });
      results.push({
        id: c.id, question: c.question, gold: c.gold, prediction: c.prediction,
        outcome: cmp.match ? 'correct' : cmp.reason,
        detail: cmp.detail || null,
        execCorrect: cmp.match,
        exactCorrect,
        ordered,
        goldRows: gold.rows.length,
        predRows: pred.rows.length,
      });
    } finally {
      db.close();
    }
  }

  return summarize(results);
}

function summarize(results) {
  const n = results.length;
  const exec = results.filter((r) => r.execCorrect).length;
  const exact = results.filter((r) => r.exactCorrect).length;

  // The cases the argument rests on: semantically right, textually different.
  const missedByExact = results.filter((r) => r.execCorrect && !r.exactCorrect);
  // The opposite would mean the baseline is unsound rather than merely strict.
  const exactOnly = results.filter((r) => !r.execCorrect && r.exactCorrect);

  const byOutcome = {};
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;

  return {
    results,
    total: n,
    executionAccuracy: n ? exec / n : 0,
    exactMatchAccuracy: n ? exact / n : 0,
    missedByExact,
    exactOnly,
    byOutcome,
  };
}
