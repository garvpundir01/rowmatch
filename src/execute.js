/* Running a query and capturing what it returned.
 *
 * Each case gets a database built fresh from the schema, so a prediction can
 * never affect a later case even if it slips past the guard.
 */

import { DatabaseSync } from 'node:sqlite';

/** Build an in-memory database from DDL + seed SQL. */
export function openDatabase(ddl) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(ddl);
  return db;
}

/**
 * Execute one query.
 *
 * @returns {{ok: true, columns: string[], rows: object[], truncated: boolean}
 *          | {ok: false, error: string}}
 */
export function runQuery(db, sql, opts = {}) {
  const maxRows = opts.maxRows || 50_000;
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all();

    // node:sqlite returns plain objects keyed by column name, in column order.
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const truncated = rows.length > maxRows;

    return {
      ok: true,
      columns,
      rows: truncated ? rows.slice(0, maxRows) : rows,
      truncated,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
