/* Prompt construction.
 *
 * Three decisions here move accuracy more than anything else in the agent:
 * what schema the model sees, whether it sees real values, and how tightly the
 * output format is pinned. The third is the cheapest win: a model that answers
 * with prose around its SQL costs you a parse, and a model that answers with
 * two statements costs you a refusal from the guard.
 */

import { serializeSchema } from './schema.js';

export const SYSTEM = [
  'You translate questions into a single SQLite SELECT query.',
  '',
  'Rules:',
  '- Reply with the query and nothing else. No prose, no explanation.',
  '- Exactly one statement. No semicolon-separated statements.',
  '- Read-only: SELECT or WITH only. Never INSERT, UPDATE, DELETE, DROP or PRAGMA.',
  '- Use only the tables and columns given to you.',
  '- Add ORDER BY only when the question asks for an order or a ranking.',
  '- When the question asks "how many", return a single count, not the rows.',
].join('\n');

export function buildPrompt({ question, tables, samples }) {
  const parts = ['Schema:\n', serializeSchema(tables)];

  if (samples && samples.length) {
    parts.push('\n\nExample rows:');
    for (const s of samples) parts.push('\n' + s.table + ': ' + JSON.stringify(s.rows));
  }

  parts.push('\n\nQuestion: ' + question);
  parts.push('\n\nSQL:');
  return parts.join('');
}

/**
 * The repair turn. The database error is handed back verbatim because it is the
 * highest-signal feedback available: "no such column: studnets" tells the model
 * exactly what to fix, and paraphrasing it throws that away.
 */
export function buildRepair(kind, detail) {
  if (kind === 'unsafe') {
    return 'That was rejected before it ran: ' + detail +
      '.\nReply with a single read-only SELECT (or WITH) statement and nothing else.';
  }
  if (kind === 'error') {
    return 'That query failed with this database error:\n\n' + detail +
      '\n\nFix the query. Reply with the corrected SQL and nothing else.';
  }
  if (kind === 'empty') {
    return [
      'That query ran but returned no rows. If that is genuinely the right answer,',
      'reply with the same query. Otherwise a predicate is probably too narrow or a',
      'join too strict; fix it and reply with the corrected SQL only.',
    ].join(' ');
  }
  return 'Try again. Reply with the corrected SQL and nothing else.';
}

/**
 * Pull SQL out of whatever the model actually said.
 *
 * Instruction-following is never perfect, so a fenced block wins when present,
 * and otherwise leading prose is trimmed back to the first statement keyword.
 * Doing this well is the difference between a harness that measures the model
 * and one that measures your parser.
 */
export function extractSQL(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();

  const fenced = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  const start = text.search(/\b(SELECT|WITH)\b/i);
  if (start > 0) text = text.slice(start);

  return text.replace(/;\s*$/, '').trim();
}
