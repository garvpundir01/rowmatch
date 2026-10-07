/* End-to-end: run the shipped benchmark and hold it to its own declared
 * expectations. Every case in cases.json carries an `expect` field, so the
 * benchmark checks itself — a case that starts behaving differently fails CI
 * instead of quietly moving the headline number. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate } from '../src/evaluate.js';
import { openDatabase, runQuery } from '../src/execute.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ddl = readFileSync(join(root, 'bench', 'schema.sql'), 'utf8');
const spec = JSON.parse(readFileSync(join(root, 'bench', 'cases.json'), 'utf8'));
const suite = { ddl, cases: spec.cases, name: spec.name };

const report = evaluate(suite);
const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));

test('every gold query runs', () => {
  const broken = report.results.filter((r) => r.outcome === 'gold_failed');
  assert.deepEqual(broken.map((r) => r.id), [], 'a benchmark whose gold queries fail measures nothing');
});

test('every case produces the outcome it declares', () => {
  for (const c of spec.cases) {
    assert.equal(byId[c.id].outcome, c.expect, `${c.id}: ${c.question}`);
  }
});

test('the destructive prediction never reaches the database', () => {
  const r = byId['q14-unsafe'];
  assert.equal(r.outcome, 'blocked_unsafe');

  // And prove the table is still there afterwards.
  const db = openDatabase(ddl);
  const check = runQuery(db, 'SELECT COUNT(*) AS n FROM enrollments');
  db.close();
  assert.equal(check.ok, true, 'enrollments survived the run');
  assert.ok(check.rows[0].n > 0);
});

test('each case runs against its own database', () => {
  // Two identical counting cases must agree, which they cannot if an earlier
  // prediction mutated shared state.
  const db = openDatabase(ddl);
  const a = runQuery(db, 'SELECT COUNT(*) AS n FROM students');
  db.close();
  const db2 = openDatabase(ddl);
  const b = runQuery(db2, 'SELECT COUNT(*) AS n FROM students');
  db2.close();
  assert.equal(a.rows[0].n, b.rows[0].n);
});

test('execution accuracy exceeds exact match on this suite', () => {
  assert.ok(
    report.executionAccuracy > report.exactMatchAccuracy,
    `execution ${report.executionAccuracy} vs exact ${report.exactMatchAccuracy}`
  );
});

test('no prediction passes exact match while returning the wrong rows', () => {
  // The reverse gap would mean the baseline is unsound rather than strict, and
  // would invalidate the comparison the project rests on.
  assert.deepEqual(report.exactOnly.map((r) => r.id), []);
});

test('the paraphrase cases are the ones exact match misses', () => {
  const missed = report.missedByExact.map((r) => r.id).sort();
  assert.deepEqual(missed, [
    'q02-count-alias',
    'q03-join-order',
    'q04-in-vs-exists',
    'q05-between',
    'q06-comma-join',
    'q07-predicate-order',
  ]);
});

test('reported totals are internally consistent', () => {
  const exec = report.results.filter((r) => r.execCorrect).length;
  assert.equal(report.executionAccuracy, exec / report.total);
  assert.equal(
    Object.values(report.byOutcome).reduce((a, b) => a + b, 0),
    report.total,
    'every case is counted exactly once'
  );
});

test('a NULL-bearing column does not crash the comparator', () => {
  // students.gpa has a NULL, enrollments.grade has a NULL.
  const db = openDatabase(ddl);
  const r = runQuery(db, 'SELECT gpa FROM students');
  db.close();
  assert.ok(r.rows.some((row) => row.gpa === null));
});
