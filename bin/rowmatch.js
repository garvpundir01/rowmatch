#!/usr/bin/env node
/* CLI: node bin/rowmatch.js [cases.json] [--schema path] [--json] [--strict-types] */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, OUTCOMES } from '../src/evaluate.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};

const casesPath = resolve(argv.find((a) => !a.startsWith('--') && a !== opt('--schema', null)) || join(root, 'bench', 'cases.json'));
const schemaPath = resolve(opt('--schema', join(root, 'bench', 'schema.sql')));

let suite;
try {
  const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
  suite = { ddl: readFileSync(schemaPath, 'utf8'), cases: cases.cases, name: cases.name };
} catch (err) {
  console.error('Could not read the suite: ' + err.message);
  process.exit(2);
}

const report = evaluate(suite, { numericStrings: !flag('--strict-types') });

if (flag('--json')) {
  console.log(JSON.stringify({
    name: suite.name,
    total: report.total,
    executionAccuracy: report.executionAccuracy,
    exactMatchAccuracy: report.exactMatchAccuracy,
    byOutcome: report.byOutcome,
    results: report.results.map((r) => ({
      id: r.id, outcome: r.outcome, execCorrect: r.execCorrect, exactCorrect: r.exactCorrect,
    })),
  }, null, 2));
  process.exit(0);
}

/* ------------------------------------------------------------ pretty print */

const C = process.stdout.isTTY
  ? { dim: '\u001b[2m', bold: '\u001b[1m', red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m', off: '\u001b[0m' }
  : { dim: '', bold: '', red: '', green: '', yellow: '', cyan: '', off: '' };

const pct = (x) => (x * 100).toFixed(1) + '%';
const mark = (ok) => (ok ? C.green + 'PASS' + C.off : C.red + 'FAIL' + C.off);

console.log('');
console.log(`${C.bold}rowmatch${C.off} ${C.dim}· ${suite.name} · ${report.total} cases${C.off}`);
console.log('');

for (const r of report.results) {
  const agree = r.execCorrect === r.exactCorrect;
  const flagChar = agree ? ' ' : C.yellow + '!' + C.off;
  console.log(` ${flagChar} ${r.id.padEnd(26)} exec ${mark(r.execCorrect)}  exact ${mark(r.exactCorrect)}  ${C.dim}${r.outcome}${C.off}`);
  if (!r.execCorrect && r.detail) {
    console.log(`   ${C.dim}${JSON.stringify(r.detail)}${C.off}`);
  }
}

console.log('');
console.log(`${C.bold}Execution accuracy${C.off}   ${pct(report.executionAccuracy)}  ${C.dim}(${report.results.filter((r) => r.execCorrect).length}/${report.total})${C.off}`);
console.log(`${C.bold}Exact-match accuracy${C.off} ${pct(report.exactMatchAccuracy)}  ${C.dim}(${report.results.filter((r) => r.exactCorrect).length}/${report.total})${C.off}`);

const gap = report.executionAccuracy - report.exactMatchAccuracy;
console.log('');
if (report.missedByExact.length) {
  console.log(`${C.yellow}Exact match under-reports by ${(gap * 100).toFixed(1)} points.${C.off}`);
  console.log(`${C.dim}${report.missedByExact.length} prediction(s) returned exactly the right rows and were scored wrong for their wording:${C.off}`);
  for (const r of report.missedByExact) console.log(`   ${C.dim}- ${r.id}: ${r.question}${C.off}`);
} else {
  console.log(`${C.dim}No prediction was penalised purely for its wording.${C.off}`);
}

if (report.exactOnly.length) {
  console.log('');
  console.log(`${C.red}${report.exactOnly.length} case(s) matched textually but returned the wrong rows — check the benchmark.${C.off}`);
}

console.log('');
console.log(`${C.bold}Outcomes${C.off}`);
for (const [k, v] of Object.entries(report.byOutcome).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(v).padStart(3)}  ${k.padEnd(20)} ${C.dim}${OUTCOMES[k] || ''}${C.off}`);
}
console.log('');

// A benchmark whose own gold queries don't run is broken, and that should fail
// a CI job rather than quietly lower the score.
process.exit(report.byOutcome.gold_failed ? 1 : 0);
