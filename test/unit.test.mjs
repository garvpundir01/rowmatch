import test from 'node:test';
import assert from 'node:assert/strict';

import { checkSafe, stripLiterals, statementCount } from '../src/guard.js';
import { normalizeSql, exactMatch } from '../src/normalize.js';
import { compareResults, canonValue, isOrdered } from '../src/compare.js';

/* ============================== the guard ============================== */

test('admits ordinary queries', () => {
  for (const q of [
    'SELECT 1',
    'select name from students',
    '  SELECT * FROM t WHERE x = 1  ',
    'WITH a AS (SELECT 1) SELECT * FROM a',
    'SELECT COUNT(*) FROM t;',
  ]) {
    assert.equal(checkSafe(q).ok, true, q);
  }
});

test('refuses anything that writes', () => {
  for (const q of [
    'DROP TABLE students',
    'DELETE FROM students',
    'UPDATE students SET gpa = 4.0',
    'INSERT INTO students VALUES (1)',
    'ALTER TABLE students ADD COLUMN x int',
    'ATTACH DATABASE \'/etc/passwd\' AS evil',
    'PRAGMA table_info(students)',
  ]) {
    assert.equal(checkSafe(q).ok, false, q);
  }
});

test('refuses a write smuggled behind a select', () => {
  const r = checkSafe('SELECT 1; DROP TABLE students');
  assert.equal(r.ok, false);
  assert.match(r.reason, /more than one statement/);
});

test('refuses a writable CTE', () => {
  assert.equal(checkSafe('WITH x AS (DELETE FROM students RETURNING id) SELECT * FROM x').ok, false);
});

test('a keyword inside a string literal is not a statement', () => {
  const r = checkSafe("SELECT 'drop table students' AS note");
  assert.equal(r.ok, true, r.reason);
});

test('a keyword inside a comment is not a statement', () => {
  assert.equal(checkSafe('SELECT 1 -- DROP TABLE students').ok, true);
  assert.equal(checkSafe('SELECT 1 /* DELETE FROM t */').ok, true);
});

test('refuses empty and non-query input', () => {
  assert.equal(checkSafe('').ok, false);
  assert.equal(checkSafe('   ').ok, false);
  assert.equal(checkSafe(null).ok, false);
  assert.equal(checkSafe('I could not answer this question').ok, false);
});

test('stripLiterals blanks strings, comments and bracket identifiers', () => {
  assert.equal(/students/.test(stripLiterals("SELECT 'students'")), false);
  assert.equal(/secret/.test(stripLiterals('SELECT 1 -- secret')), false);
  assert.equal(/secret/.test(stripLiterals('SELECT 1 /* secret */')), false);
  assert.equal(/weird/.test(stripLiterals('SELECT [weird name] FROM t')), false);
  assert.equal(/students/.test(stripLiterals('SELECT * FROM students')), true);
});

test('counts statements outside literals', () => {
  assert.equal(statementCount('SELECT 1'), 1);
  assert.equal(statementCount('SELECT 1;'), 1);
  assert.equal(statementCount('SELECT 1; SELECT 2'), 2);
  assert.equal(statementCount("SELECT ';;;'"), 1);
});

/* ============================ normalisation ============================ */

test('normalisation folds the cosmetic differences', () => {
  assert.equal(
    normalizeSql('SELECT   name\n  FROM students  -- a comment\n'),
    normalizeSql('select name from students')
  );
  assert.equal(normalizeSql('SELECT a FROM t;'), normalizeSql('select  a  from  t'));
  assert.equal(normalizeSql('SELECT COUNT( * ) FROM t'), normalizeSql('select count(*) from t'));
});

test('normalisation keeps string literals verbatim', () => {
  assert.notEqual(
    normalizeSql("SELECT * FROM d WHERE name = 'Computer Sciences'"),
    normalizeSql("SELECT * FROM d WHERE name = 'computer sciences'")
  );
});

test('normalisation strips one layer of redundant parentheses', () => {
  assert.equal(normalizeSql('(SELECT 1)'), normalizeSql('SELECT 1'));
  // But not when the parentheses are part of the expression.
  assert.notEqual(normalizeSql('(SELECT 1) UNION (SELECT 2)'), normalizeSql('SELECT 1'));
});

test('exact match cannot see through a paraphrase', () => {
  assert.equal(exactMatch('SELECT COUNT(*) FROM students', 'SELECT COUNT(*) FROM students'), true);
  assert.equal(exactMatch('SELECT COUNT(*) FROM students', 'SELECT COUNT(1) AS n FROM students s'), false);
});

/* ============================ value canon ============================== */

test('numbers compare across integer and float spellings', () => {
  assert.equal(canonValue(3), canonValue(3.0));
  assert.equal(canonValue(0.1 + 0.2), canonValue(0.3));
  assert.equal(canonValue(10n), canonValue(10));
  assert.equal(canonValue(true), canonValue(1));
});

test('null is its own value and is not zero or empty string', () => {
  assert.equal(canonValue(null), canonValue(undefined));
  assert.notEqual(canonValue(null), canonValue(0));
  assert.notEqual(canonValue(null), canonValue(''));
});

test('numeric strings coerce by default and not under strict types', () => {
  assert.equal(canonValue('3'), canonValue(3));
  assert.notEqual(canonValue('3', { numericStrings: false }), canonValue(3));
  // A zero-padded code is not a number and must survive either way.
  assert.notEqual(canonValue('007'), canonValue(7));
});

/* ============================== ordering =============================== */

test('ordering is taken from a top-level ORDER BY only', () => {
  assert.equal(isOrdered('SELECT a FROM t ORDER BY a', stripLiterals), true);
  assert.equal(isOrdered('SELECT a FROM t', stripLiterals), false);
  assert.equal(isOrdered('SELECT a FROM (SELECT a FROM t ORDER BY a)', stripLiterals), false);
  assert.equal(
    isOrdered("SELECT a FROM t WHERE note = 'order by'", stripLiterals),
    false,
    'a literal must not be read as a clause'
  );
});

/* ============================== comparison ============================= */

const rs = (columns, rows) => ({ columns, rows });

test('identical result sets match', () => {
  const a = rs(['n'], [{ n: 1 }, { n: 2 }]);
  assert.equal(compareResults(a, a, { ordered: false }).match, true);
});

test('column names do not matter, positions do', () => {
  const gold = rs(['count(*)'], [{ 'count(*)': 5 }]);
  const pred = rs(['n'], [{ n: 5 }]);
  assert.equal(compareResults(gold, pred, { ordered: false }).match, true);
});

test('row order is ignored unless the question is ordered', () => {
  const gold = rs(['n'], [{ n: 1 }, { n: 2 }]);
  const pred = rs(['n'], [{ n: 2 }, { n: 1 }]);
  assert.equal(compareResults(gold, pred, { ordered: false }).match, true);

  const ord = compareResults(gold, pred, { ordered: true });
  assert.equal(ord.match, false);
  assert.equal(ord.reason, 'wrong_order', 'same rows, wrong sequence gets its own label');
});

test('duplicates are significant — rows are a multiset, not a set', () => {
  const gold = rs(['d'], [{ d: 'cs' }, { d: 'cs' }, { d: 'math' }]);
  const pred = rs(['d'], [{ d: 'cs' }, { d: 'math' }]);
  const r = compareResults(gold, pred, { ordered: false });
  assert.equal(r.match, false);
  assert.equal(r.reason, 'missing_rows');
});

test('an extra column is caught before values are compared', () => {
  const gold = rs(['title'], [{ title: 'DBMS' }]);
  const pred = rs(['title', 'credits'], [{ title: 'DBMS', credits: 4 }]);
  const r = compareResults(gold, pred, { ordered: false });
  assert.equal(r.reason, 'wrong_column_count');
});

test('empty against empty matches; empty against rows does not', () => {
  assert.equal(compareResults(rs([], []), rs([], []), {}).match, true);
  assert.equal(compareResults(rs([], []), rs(['n'], [{ n: 1 }]), {}).reason, 'extra_rows');
  assert.equal(compareResults(rs(['n'], [{ n: 1 }]), rs([], []), {}).reason, 'missing_rows');
});

test('nulls compare as values, not as missing', () => {
  const gold = rs(['g'], [{ g: null }, { g: 3.5 }]);
  const pred = rs(['g'], [{ g: null }, { g: 3.5 }]);
  assert.equal(compareResults(gold, pred, { ordered: false }).match, true);

  const wrong = rs(['g'], [{ g: 0 }, { g: 3.5 }]);
  assert.equal(compareResults(gold, wrong, { ordered: false }).match, false);
});

test('a value difference reports which side has the unmatched rows', () => {
  const gold = rs(['n'], [{ n: 1 }, { n: 2 }]);
  const pred = rs(['n'], [{ n: 1 }, { n: 3 }]);
  const r = compareResults(gold, pred, { ordered: false });
  assert.equal(r.reason, 'wrong_values');
  assert.equal(r.detail.rowsOnlyInGold, 1);
  assert.equal(r.detail.rowsOnlyInPrediction, 1);
});

test('ordered comparison of different lengths is a row-count failure', () => {
  const gold = rs(['n'], [{ n: 1 }, { n: 2 }, { n: 3 }]);
  const pred = rs(['n'], [{ n: 1 }, { n: 2 }]);
  assert.equal(compareResults(gold, pred, { ordered: true }).reason, 'missing_rows');
});
