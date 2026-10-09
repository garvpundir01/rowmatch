/* Schema introspection and schema linking.
 *
 * A production database has hundreds of tables. They don't fit in a prompt, and
 * stuffing in irrelevant ones measurably hurts accuracy — the model picks a
 * plausible-looking wrong table. So before prompting you have to decide which
 * tables the question is probably about. That is schema linking, and it is a
 * retrieval problem.
 *
 * The scorer here is lexical, not learned: token overlap between the question
 * and each table's name and column names, then expansion along foreign keys so
 * a join target comes along with the table that references it. It is a baseline,
 * and a deliberately legible one — you can always explain why a table was
 * included. Embedding similarity is the upgrade, and it is a drop-in for
 * `scoreTable` alone.
 */

/* PRAGMA is forbidden in predictions by src/guard.js. This is our own
 * introspection, not model output, so it is allowed here. */
export function introspect(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

  return tables.map((name) => {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => ({
      name: c.name,
      type: c.type,
      notnull: !!c.notnull,
      pk: !!c.pk,
    }));
    const fks = db.prepare(`PRAGMA foreign_key_list("${name}")`).all().map((f) => ({
      from: f.from,
      table: f.table,
      to: f.to,
    }));
    return { name, columns, fks };
  });
}

/** CREATE TABLE text, which models read far better than a bullet list. */
export function serializeSchema(tables) {
  return tables
    .map((t) => {
      const cols = t.columns.map((c) => {
        const bits = [`  ${c.name} ${c.type || 'TEXT'}`];
        if (c.pk) bits.push('PRIMARY KEY');
        else if (c.notnull) bits.push('NOT NULL');
        return bits.join(' ');
      });
      const fks = t.fks.map((f) => `  FOREIGN KEY (${f.from}) REFERENCES ${f.table}(${f.to})`);
      return `CREATE TABLE ${t.name} (\n${cols.concat(fks).join(',\n')}\n);`;
    })
    .join('\n\n');
}

/** A few real rows help the model get value formats right (dates, enums). */
export function sampleRows(db, tables, n = 2) {
  const out = [];
  for (const t of tables) {
    try {
      const rows = db.prepare(`SELECT * FROM "${t.name}" LIMIT ${Number(n) || 2}`).all();
      if (rows.length) out.push({ table: t.name, rows });
    } catch {
      // A table we cannot sample is not worth failing the whole prompt over.
    }
  }
  return out;
}

const STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are',
  'what', 'which', 'who', 'how', 'many', 'much', 'list', 'show', 'find', 'give',
  'me', 'all', 'with', 'by', 'from', 'that', 'their', 'there', 'each', 'per',
  'count', 'number', 'name', 'names', 'average', 'total', 'sum', 'have', 'has',
]);

function tokens(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Crude singular/plural folding so "students" matches a `student` column. */
function stem(w) {
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1);
  return w;
}

export function scoreTable(table, questionTokens) {
  const q = new Set(questionTokens.map(stem));
  let score = 0;

  for (const w of tokens(table.name)) {
    if (q.has(stem(w))) score += 3;            // the table name is the strongest signal
  }
  for (const col of table.columns) {
    for (const w of tokens(col.name)) {
      if (q.has(stem(w))) score += 1;
    }
  }
  return score;
}

/**
 * Pick the tables a question is probably about.
 *
 * Returns every table when the schema already fits, because filtering a small
 * schema can only lose information. Above the threshold it scores, takes the
 * best, then pulls in anything they reference so joins stay possible.
 */
export function linkSchema(tables, question, opts = {}) {
  const maxTables = opts.maxTables || 8;
  const alwaysFitBelow = opts.alwaysFitBelow ?? maxTables;

  if (tables.length <= alwaysFitBelow) {
    return { tables, linked: false, reason: 'schema fits in the prompt' };
  }

  const qt = tokens(question);
  const scored = tables
    .map((t) => ({ t, score: scoreTable(t, qt) }))
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));

  const chosen = new Map();
  for (const { t, score } of scored) {
    if (chosen.size >= maxTables) break;
    if (score === 0 && chosen.size > 0) break;   // stop at the first table with no signal
    chosen.set(t.name, t);
  }

  // Expand one hop along foreign keys, in both directions, so a join target is
  // never missing just because the question did not name it.
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const t of [...chosen.values()]) {
    for (const fk of t.fks) {
      if (chosen.size >= maxTables) break;
      const target = byName.get(fk.table);
      if (target && !chosen.has(target.name)) chosen.set(target.name, target);
    }
  }
  for (const t of tables) {
    if (chosen.size >= maxTables) break;
    if (chosen.has(t.name)) continue;
    if (t.fks.some((fk) => chosen.has(fk.table))) chosen.set(t.name, t);
  }

  return {
    tables: [...chosen.values()],
    linked: true,
    reason: `selected ${chosen.size} of ${tables.length} tables`,
  };
}
