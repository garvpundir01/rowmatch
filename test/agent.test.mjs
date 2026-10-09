/* Agent tests.
 *
 * The whole loop runs against MockProvider, so these need no network, no key
 * and no money. That is the reason the provider is an interface: a loop you can
 * only exercise by spending money is a loop nobody tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MockProvider } from '../src/agent/provider.js';
import { generateSQL, runAgent } from '../src/agent/agent.js';
import { extractSQL, buildPrompt } from '../src/agent/prompt.js';
import { introspect, linkSchema, serializeSchema, scoreTable } from '../src/agent/schema.js';
import { openDatabase } from '../src/execute.js';
import { evaluate } from '../src/evaluate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ddl = readFileSync(join(root, 'bench', 'schema.sql'), 'utf8');

/** A markdown code fence, written as escapes to keep the source shell-safe. */
const FENCE = '```';

const withDb = async (fn) => {
  const db = openDatabase(ddl);
  try { return await fn(db); } finally { db.close(); }
};

/* ============================= SQL extraction ========================== */

test('pulls SQL out of a fenced block', () => {
  assert.equal(extractSQL(FENCE + 'sql\nSELECT 1\n' + FENCE), 'SELECT 1');
  assert.equal(extractSQL(FENCE + '\nSELECT 1\n' + FENCE), 'SELECT 1');
});

test('strips prose the model added anyway', () => {
  assert.equal(extractSQL('Sure! Here is the query:\nSELECT 1'), 'SELECT 1');
  assert.equal(extractSQL('SELECT 1;'), 'SELECT 1');
});

test('survives junk', () => {
  assert.equal(extractSQL(''), '');
  assert.equal(extractSQL(null), '');
  assert.equal(extractSQL('I cannot answer that'), 'I cannot answer that');
});

/* ============================ schema linking =========================== */

test('introspection finds tables, columns and foreign keys', async () => {
  await withDb((db) => {
    const tables = introspect(db);
    assert.deepEqual(
      tables.map((t) => t.name).sort(),
      ['courses', 'departments', 'enrollments', 'instructors', 'students']
    );

    const enrollments = tables.find((t) => t.name === 'enrollments');
    assert.ok(enrollments.fks.some((f) => f.table === 'students'));
    assert.ok(enrollments.fks.some((f) => f.table === 'courses'));

    const students = tables.find((t) => t.name === 'students');
    assert.ok(students.columns.some((c) => c.name === 'gpa'));
    assert.ok(students.columns.find((c) => c.name === 'id').pk);
  });
});

test('serialised schema reads as DDL', async () => {
  await withDb((db) => {
    const text = serializeSchema(introspect(db));
    assert.match(text, /CREATE TABLE students/);
    assert.match(text, /FOREIGN KEY \(dept_id\) REFERENCES departments\(id\)/);
  });
});

test('a small schema is passed through whole', async () => {
  await withDb((db) => {
    const tables = introspect(db);
    const link = linkSchema(tables, 'how many students are there');
    assert.equal(link.linked, false, 'five tables fit, so filtering could only lose information');
    assert.equal(link.tables.length, tables.length);
  });
});

test('scoring prefers the table the question names', async () => {
  await withDb((db) => {
    const tables = introspect(db);
    const q = ['student', 'gpa'];
    const students = scoreTable(tables.find((t) => t.name === 'students'), q);
    const courses = scoreTable(tables.find((t) => t.name === 'courses'), q);
    assert.ok(students > courses, 'students ' + students + ' should outscore courses ' + courses);
  });
});

test('a large schema is filtered, and join targets come along', async () => {
  await withDb((db) => {
    const real = introspect(db);
    const noise = Array.from({ length: 20 }, (_, i) => ({
      name: 'unrelated_' + i,
      columns: [{ name: 'id', type: 'INTEGER', pk: true }],
      fks: [],
    }));
    const link = linkSchema(real.concat(noise), 'which courses is each student enrolled in', { maxTables: 6 });

    assert.equal(link.linked, true);
    assert.ok(link.tables.length <= 6);
    const names = link.tables.map((t) => t.name);
    assert.ok(names.includes('students'), names.join(','));
    assert.ok(names.includes('courses'), names.join(','));
    assert.ok(
      names.includes('enrollments'),
      'the join table is pulled in by foreign key even though the question never names it'
    );
  });
});

test('the prompt carries the schema and the question', async () => {
  await withDb((db) => {
    const p = buildPrompt({ question: 'how many students?', tables: introspect(db), samples: [] });
    assert.match(p, /CREATE TABLE students/);
    assert.match(p, /Question: how many students\?/);
  });
});

/* ============================== the loop =============================== */

test('a good first answer needs no repair', async () => {
  await withDb(async (db) => {
    const provider = new MockProvider({ 'how many students': ['SELECT COUNT(*) FROM students'] });
    const r = await generateSQL({ question: 'how many students are there', db, provider });
    assert.equal(r.ok, true);
    assert.equal(r.repaired, false);
    assert.equal(r.attempts.length, 1);
  });
});

test('a database error is fed back and the second attempt succeeds', async () => {
  await withDb(async (db) => {
    const provider = new MockProvider({
      'how many students': [
        'SELECT COUNT(*) FROM studnets',
        'SELECT COUNT(*) FROM students',
      ],
    });
    const r = await generateSQL({ question: 'how many students are there', db, provider });

    assert.equal(r.ok, true);
    assert.equal(r.repaired, true);
    assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts[0].kind, 'error');
    assert.match(r.attempts[0].error, /studnets/);

    const repairTurn = provider.calls[1].messages.at(-1).content;
    assert.match(repairTurn, /no such table|studnets/i, 'the real error text is the signal');
  });
});

test('unsafe output is refused, fed back, and recovered', async () => {
  await withDb(async (db) => {
    const provider = new MockProvider({
      'how many enrollments': ['DROP TABLE enrollments', 'SELECT COUNT(*) FROM enrollments'],
    });
    const r = await generateSQL({ question: 'how many enrollments are there', db, provider });

    assert.equal(r.ok, true);
    assert.equal(r.attempts[0].kind, 'unsafe');
    assert.match(r.attempts[0].error, /DROP/);

    const still = db.prepare('SELECT COUNT(*) AS n FROM enrollments').all();
    assert.ok(still[0].n > 0, 'the destructive statement never reached the database');
  });
});

test('gives up after maxAttempts instead of looping forever', async () => {
  await withDb(async (db) => {
    const provider = new MockProvider({ 'how many students': ['SELECT * FROM nope'] });
    const r = await generateSQL({
      question: 'how many students are there', db, provider, options: { maxAttempts: 3 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.attempts.length, 3);
  });
});

test('a provider failure stops the loop rather than retrying blindly', async () => {
  await withDb(async (db) => {
    const broken = { complete: async () => { throw new Error('connection reset'); } };
    const r = await generateSQL({ question: 'how many students', db, provider: broken });
    assert.equal(r.ok, false);
    assert.equal(r.attempts.length, 1, 'a transport failure is not repairable by prompting');
    assert.match(r.attempts[0].error, /connection reset/);
  });
});

test('empty results are accepted by default and retried only on request', async () => {
  const q = 'students with a gpa above 9';
  const sql = 'SELECT name FROM students WHERE gpa > 9.0';

  await withDb(async (db) => {
    const provider = new MockProvider({ 'gpa above 9': [sql] });
    const r = await generateSQL({ question: q, db, provider });
    assert.equal(r.ok, true, 'no rows is a legitimate answer');
    assert.equal(r.attempts.length, 1);
  });

  await withDb(async (db) => {
    const provider = new MockProvider({
      'gpa above 9': [sql, 'SELECT name FROM students WHERE gpa > 3.9'],
    });
    const r = await generateSQL({ question: q, db, provider, options: { retryOnEmpty: true } });
    assert.equal(r.attempts[0].kind, 'empty');
    assert.equal(r.attempts.length, 2);
  });
});

/* ====================== the agent feeds the evaluator =================== */

test('agent output scores through rowmatch unchanged', async () => {
  const questions = [
    { id: 'a', question: 'how many students are there', gold: 'SELECT COUNT(*) FROM students' },
    { id: 'b', question: 'list department names', gold: 'SELECT name FROM departments' },
  ];
  const provider = new MockProvider({
    'how many students': ['SELECT COUNT(1) AS total FROM students s'],
    'list department names': ['SELECT building FROM departments'],
  });

  const predictions = await runAgent({ ddl, questions, provider });
  const report = evaluate({ ddl, cases: predictions });

  assert.equal(report.total, 2);
  const a = report.results.find((r) => r.id === 'a');
  const b = report.results.find((r) => r.id === 'b');

  assert.equal(a.execCorrect, true, 'the paraphrase is scored correct on its rows');
  assert.equal(a.exactCorrect, false, 'and string matching would have called it wrong');
  assert.equal(b.execCorrect, false);
  assert.equal(b.outcome, 'wrong_values');
});

test('each question gets its own database', async () => {
  const questions = [
    { id: 'a', question: 'how many enrollments are there', gold: 'SELECT COUNT(*) FROM enrollments' },
    { id: 'b', question: 'count the enrollments again', gold: 'SELECT COUNT(*) FROM enrollments' },
  ];
  const provider = new MockProvider({}, 'SELECT COUNT(*) FROM enrollments');
  const predictions = await runAgent({ ddl, questions, provider });
  const report = evaluate({ ddl, cases: predictions });
  assert.ok(report.results.every((r) => r.execCorrect));
});
