/* The agent loop.
 *
 *   link schema -> prompt -> generate -> guard -> execute
 *                              ^                     |
 *                              +--- feed the error --+
 *
 * The loop is the whole point. A single generate-and-hope call is a prompt, not
 * an agent; what makes this agentic is that the environment answers back and
 * the model gets to use the answer. A database is an unusually good environment
 * for this because its errors are precise, cheap and truthful.
 *
 * What the loop can and cannot fix is worth being explicit about. It fixes
 * syntax errors, hallucinated columns and refused output, because those raise.
 * It cannot fix a query that runs and returns confidently wrong rows, because
 * nothing in the environment objects to those. That failure mode is exactly
 * what the evaluation harness measures, which is why the two halves belong in
 * one repository.
 */

import { checkSafe } from '../guard.js';
import { runQuery, openDatabase } from '../execute.js';
import { introspect, linkSchema, sampleRows } from './schema.js';
import { SYSTEM, buildPrompt, buildRepair, extractSQL } from './prompt.js';

export async function generateSQL({ question, db, provider, options = {} }) {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryOnEmpty = options.retryOnEmpty === true;
  const withSamples = options.samples !== false;

  const all = introspect(db);
  const link = linkSchema(all, question, { maxTables: options.maxTables || 8 });
  const samples = withSamples ? sampleRows(db, link.tables, 2) : [];

  const messages = [
    { role: 'user', content: buildPrompt({ question, tables: link.tables, samples }) },
  ];
  const attempts = [];
  let lastSql = '';

  for (let n = 1; n <= maxAttempts; n++) {
    let raw;
    try {
      raw = await provider.complete({ system: SYSTEM, messages });
    } catch (err) {
      attempts.push({ n, kind: 'provider', error: 'provider: ' + err.message });
      break;
    }

    const sql = extractSQL(raw);
    lastSql = sql || lastSql;

    const safe = checkSafe(sql);
    if (!safe.ok) {
      attempts.push({ n, sql, kind: 'unsafe', error: safe.reason });
      if (n === maxAttempts) break;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: buildRepair('unsafe', safe.reason) });
      continue;
    }

    const run = runQuery(db, sql);
    if (!run.ok) {
      attempts.push({ n, sql, kind: 'error', error: run.error });
      if (n === maxAttempts) break;
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: buildRepair('error', run.error) });
      continue;
    }

    // Retrying on an empty result is off by default on purpose. "No rows" is a
    // correct answer to plenty of questions, so nudging the model away from it
    // trades one error class for another. It is a flag so the tradeoff can be
    // measured rather than assumed.
    if (retryOnEmpty && run.rows.length === 0 && n < maxAttempts) {
      attempts.push({ n, sql, kind: 'empty', rows: 0 });
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: buildRepair('empty') });
      continue;
    }

    attempts.push({ n, sql, kind: 'ok', rows: run.rows.length });
    return {
      sql,
      attempts,
      ok: true,
      repaired: n > 1,
      schemaLinked: link.linked,
      tablesShown: link.tables.map((t) => t.name),
    };
  }

  return {
    sql: lastSql,
    attempts,
    ok: false,
    repaired: false,
    schemaLinked: link.linked,
    tablesShown: link.tables.map((t) => t.name),
  };
}

/** Run the agent over a question set, producing predictions rowmatch can score. */
export async function runAgent({ ddl, questions, provider, options = {} }) {
  const out = [];
  for (const q of questions) {
    const db = openDatabase(ddl);
    try {
      const r = await generateSQL({ question: q.question, db, provider, options });
      out.push({
        id: q.id,
        question: q.question,
        gold: q.gold,
        prediction: r.sql,
        expect: q.expect,
        agent: {
          ok: r.ok,
          attemptCount: r.attempts.length,
          repaired: r.repaired,
          attempts: r.attempts,
          tablesShown: r.tablesShown,
        },
      });
    } finally {
      db.close();
    }
  }
  return out;
}
