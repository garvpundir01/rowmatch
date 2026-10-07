/* Result-set equivalence — the part that makes execution accuracy mean
 * something.
 *
 * Two queries answer the same question when they return the same values, not
 * when they return the same text. Deciding that needs four judgments, and
 * getting any of them wrong silently changes the score:
 *
 *   1. ORDER. SQL result sets are unordered unless the query says otherwise.
 *      Comparing as sequences marks a correct answer wrong whenever the engine
 *      happened to return rows in another order; comparing as sets marks a
 *      wrong answer right whenever the question actually asked for a ranking.
 *      So order matters only when the gold query has a top-level ORDER BY.
 *
 *   2. DUPLICATES. Sets are the wrong model: `SELECT dept FROM students`
 *      returning one row per student is not the same answer as one row per
 *      department. Rows are compared as a MULTISET.
 *
 *   3. NAMES. `COUNT(*)` and `COUNT(*) AS total` are the same answer, so
 *      columns are compared by position and only values are compared.
 *
 *   4. TYPES. SQLite is dynamically typed and an aggregate may come back as
 *      3 or 3.0 or "3" depending on how it was written. Values are canonicalised
 *      before comparison; see `canonValue`.
 */

/** Relative tolerance for floating point. */
const FLOAT_EPSILON = 1e-9;

/** True when the gold query's own text makes the row order meaningful. */
export function isOrdered(sql, stripLiterals) {
  const bare = (stripLiterals ? stripLiterals(sql) : String(sql)).toUpperCase();
  // Only a top-level ORDER BY counts. One inside a subquery or a window frame
  // does not fix the order of the outer result, so parenthesised regions are
  // removed before looking.
  let depth = 0;
  let top = '';
  for (const ch of bare) {
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) top += ch;
  }
  return /\bORDER\s+BY\b/.test(top);
}

/**
 * Canonical form of one cell.
 *
 * `numericStrings` decides whether "3" from one engine equals 3 from another.
 * It defaults on because dynamic typing makes the distinction an artifact of
 * how the query was written rather than of the answer, but it is a real
 * judgment call — a column of zero-padded codes ("007") would be flattened —
 * so it is a flag rather than a silent assumption.
 */
export function canonValue(v, opts = {}) {
  const numericStrings = opts.numericStrings !== false;

  if (v === null || v === undefined) return '\u0000null';
  if (typeof v === 'boolean') return 'n:' + (v ? 1 : 0);
  if (typeof v === 'bigint') return 'n:' + v.toString();

  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'n:' + String(v);
    if (Number.isInteger(v)) return 'n:' + v;
    // Round to a fixed grid so 0.1+0.2 and 0.3 agree.
    const r = Math.abs(v) < 1 ? v.toFixed(12) : v.toPrecision(12);
    return 'n:' + String(Number(r));
  }

  if (v instanceof Uint8Array) {
    return 'b:' + Array.from(v).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const s = String(v);
  if (numericStrings) {
    const t = s.trim();
    // Only a plain, unpadded number — "007" and "1e999" stay strings.
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return canonValue(n, opts);
    }
  }
  return 's:' + s;
}

function canonRow(row, columns, opts) {
  return columns.map((c) => canonValue(row[c], opts)).join('\u0001');
}

function counts(rows) {
  const m = new Map();
  for (const r of rows) m.set(r, (m.get(r) || 0) + 1);
  return m;
}

/**
 * Compare two executed result sets.
 *
 * @param {{columns: string[], rows: object[]}} gold
 * @param {{columns: string[], rows: object[]}} pred
 * @param {{ordered?: boolean, numericStrings?: boolean}} opts
 * @returns {{match: boolean, reason: string, detail?: object}}
 */
export function compareResults(gold, pred, opts = {}) {
  const ordered = !!opts.ordered;

  const gRows = gold.rows || [];
  const pRows = pred.rows || [];

  if (gRows.length === 0 && pRows.length === 0) {
    return { match: true, reason: 'both empty' };
  }

  // Column shape is only knowable from a returned row; an empty side cannot
  // disagree about columns, only about rows.
  const gCols = gold.columns && gold.columns.length ? gold.columns : Object.keys(gRows[0] || {});
  const pCols = pred.columns && pred.columns.length ? pred.columns : Object.keys(pRows[0] || {});

  if (gRows.length === 0 || pRows.length === 0) {
    return {
      match: false,
      reason: gRows.length === 0 ? 'extra_rows' : 'missing_rows',
      detail: { goldRows: gRows.length, predRows: pRows.length },
    };
  }

  if (gCols.length !== pCols.length) {
    return {
      match: false,
      reason: 'wrong_column_count',
      detail: { goldColumns: gCols.length, predColumns: pCols.length },
    };
  }

  const g = gRows.map((r) => canonRow(r, gCols, opts));
  const p = pRows.map((r) => canonRow(r, pCols, opts));

  if (ordered) {
    if (g.length !== p.length) {
      return {
        match: false,
        reason: g.length > p.length ? 'missing_rows' : 'extra_rows',
        detail: { goldRows: g.length, predRows: p.length },
      };
    }
    for (let i = 0; i < g.length; i++) {
      if (g[i] !== p[i]) {
        // Same bag of rows in a different sequence is a specific, common
        // failure (a missing or reversed ORDER BY) and worth naming.
        const sortedEqual = g.slice().sort().join('\u0002') === p.slice().sort().join('\u0002');
        return {
          match: false,
          reason: sortedEqual ? 'wrong_order' : 'wrong_values',
          detail: { firstDifferenceAtRow: i },
        };
      }
    }
    return { match: true, reason: 'ordered rows identical' };
  }

  if (g.length !== p.length) {
    return {
      match: false,
      reason: g.length > p.length ? 'missing_rows' : 'extra_rows',
      detail: { goldRows: g.length, predRows: p.length },
    };
  }

  const gc = counts(g);
  const pc = counts(p);
  let missing = 0;
  let extra = 0;
  for (const [row, n] of gc) missing += Math.max(0, n - (pc.get(row) || 0));
  for (const [row, n] of pc) extra += Math.max(0, n - (gc.get(row) || 0));

  if (missing === 0 && extra === 0) {
    return { match: true, reason: 'same multiset of rows' };
  }
  return {
    match: false,
    reason: 'wrong_values',
    detail: { rowsOnlyInGold: missing, rowsOnlyInPrediction: extra },
  };
}
