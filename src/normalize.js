/* The baseline this project exists to argue against.
 *
 * String-matching a predicted query against a gold query is the metric a lot
 * of text-to-SQL work reports, because it needs no database. It is implemented
 * here in its most charitable form — comments stripped, whitespace collapsed,
 * case folded, trailing semicolon and outer parentheses removed — so that the
 * gap measured against execution accuracy is a floor, not an artifact of a
 * deliberately weak baseline.
 *
 * Even at its most generous it cannot see that
 *   SELECT COUNT(*) FROM students WHERE gpa > 3.5
 * and
 *   SELECT COUNT(1) AS n FROM students s WHERE s.gpa > 3.5
 * are the same answer.
 */

import { stripLiterals } from './guard.js';

/** Case-fold everything outside string literals, keeping literals verbatim. */
function foldOutsideLiterals(sql) {
  const s = String(sql);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let k = i + 1;
      while (k < s.length) {
        if (s[k] === quote && s[k + 1] === quote) { k += 2; continue; }
        if (s[k] === quote) { k++; break; }
        k++;
      }
      out += s.slice(i, k);          // literal kept as written
      i = k;
      continue;
    }
    out += c.toLowerCase();
    i++;
  }
  return out;
}

export function normalizeSql(sql) {
  if (typeof sql !== 'string') return '';

  // Comment removal reuses the literal-aware scanner, then the original text is
  // folded so string contents survive.
  const withoutComments = String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');

  let out = foldOutsideLiterals(withoutComments);

  out = out
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .replace(/;\s*$/, '')
    .trim();

  // Drop one layer of redundant outer parentheses: (SELECT ...) == SELECT ...
  while (out.startsWith('(') && out.endsWith(')')) {
    const inner = out.slice(1, -1);
    let depth = 0;
    let balanced = true;
    for (const ch of stripLiterals(inner)) {
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth < 0) { balanced = false; break; } }
    }
    if (!balanced || depth !== 0) break;
    out = inner.trim();
  }

  return out;
}

/** The exact-match baseline verdict. */
export function exactMatch(goldSql, predSql) {
  return normalizeSql(goldSql) === normalizeSql(predSql);
}
