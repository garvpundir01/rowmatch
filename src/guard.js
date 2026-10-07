/* Predicted SQL is untrusted input.
 *
 * An evaluation harness runs text a model wrote, against a database, on your
 * machine. A model that emits `DROP TABLE students` is not a hypothetical: it
 * is a plausible decoding failure, and a harness that runs it silently
 * corrupts the benchmark it is measuring — every later case scores against a
 * mutilated database and the whole run is quietly wrong.
 *
 * So predictions are admitted only when they are a single read-only query.
 * Everything else is refused and scored as a failure, which is the honest
 * outcome: a model that cannot produce a SELECT did not answer the question.
 */

/** Statement keywords that must never appear at the start of a statement. */
const FORBIDDEN = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'REPLACE',
  'TRUNCATE', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'GRANT', 'REVOKE',
]);

/**
 * Strip comments and string/identifier literals, replacing each with a space.
 * Keyword checks run against this, so `SELECT 'drop table'` stays admissible
 * while `DROP TABLE` does not.
 */
export function stripLiterals(sql) {
  let out = '';
  let i = 0;
  const s = String(sql);

  while (i < s.length) {
    const c = s[i];
    const two = s.slice(i, i + 2);

    if (two === '--') {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end;
      out += ' ';
      continue;
    }
    if (two === '/*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let k = i + 1;
      while (k < s.length) {
        if (s[k] === quote && s[k + 1] === quote) { k += 2; continue; }
        if (s[k] === quote) { k++; break; }
        k++;
      }
      i = k;
      out += ' ';
      continue;
    }
    if (c === '[') {                     // SQL Server style identifier
      const end = s.indexOf(']', i);
      i = end === -1 ? s.length : end + 1;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Split on semicolons that sit outside literals. */
export function statementCount(sql) {
  const bare = stripLiterals(sql);
  return bare.split(';').filter((part) => part.trim().length > 0).length;
}

/**
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkSafe(sql) {
  if (typeof sql !== 'string' || !sql.trim()) {
    return { ok: false, reason: 'empty prediction' };
  }

  const bare = stripLiterals(sql);

  if (statementCount(sql) > 1) {
    return { ok: false, reason: 'more than one statement' };
  }

  const words = bare.toUpperCase().match(/[A-Z_]+/g) || [];
  if (!words.length) return { ok: false, reason: 'no SQL found' };

  const first = words[0];
  if (first !== 'SELECT' && first !== 'WITH' && first !== 'VALUES') {
    return { ok: false, reason: `starts with ${first}, not a query` };
  }

  // A CTE may legally contain the word CREATE nowhere, but INSERT/UPDATE/DELETE
  // are writable CTEs in some engines — refuse them anywhere in the statement.
  for (const w of words) {
    if (FORBIDDEN.has(w)) {
      // CREATE inside a WITH clause is still a write; so is INSERT.
      return { ok: false, reason: `contains ${w}` };
    }
  }

  return { ok: true };
}
