#!/usr/bin/env node
/* Run the text-to-SQL agent over a question set, then score it with rowmatch.
 *
 *   node bin/agent.js --provider anthropic
 *   node bin/agent.js --provider ollama --model qwen2.5-coder:7b
 *   node bin/agent.js --provider anthropic --ablate     # 1 attempt vs N
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProvider } from '../src/agent/provider.js';
import { runAgent } from '../src/agent/agent.js';
import { evaluate } from '../src/evaluate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 || i === argv.length - 1 ? d : argv[i + 1];
};

const ddl = readFileSync(resolve(opt('--schema', join(root, 'bench', 'schema.sql'))), 'utf8');
const spec = JSON.parse(readFileSync(resolve(opt('--cases', join(root, 'bench', 'cases.json'))), 'utf8'));
const questions = spec.cases.map((c) => ({ id: c.id, question: c.question, gold: c.gold, expect: c.expect }));

const providerName = opt('--provider', 'mock');
const scriptPath = opt('--script', providerName === 'mock' ? join(root, 'bench', 'mock-script.json') : null);
let script;
if (providerName === 'mock' && scriptPath) {
  const raw = JSON.parse(readFileSync(resolve(scriptPath), 'utf8'));
  delete raw._note;
  script = raw;
}
/* A factory, not a single instance. The scripted provider is stateful (it
 * serves replies in order), so reusing one across both arms of the ablation
 * would let the second arm start from the first arm's leftover position and
 * silently measure mock state instead of the repair loop. */
const makeProvider = () => createProvider(providerName, {
  model: opt('--model', undefined),
  effort: opt('--effort', 'medium'),
  script,
});

const C = process.stdout.isTTY
  ? { dim: '\u001b[2m', bold: '\u001b[1m', green: '\u001b[32m', red: '\u001b[31m', yellow: '\u001b[33m', off: '\u001b[0m' }
  : { dim: '', bold: '', green: '', red: '', yellow: '', off: '' };
const pct = (x) => (x * 100).toFixed(1) + '%';

async function pass(maxAttempts) {
  const predictions = await runAgent({ ddl, questions, provider: makeProvider(), options: { maxAttempts } });
  const report = evaluate({ ddl, cases: predictions });
  return { predictions, report };
}

const attempts = Number(opt('--attempts', '3')) || 3;

console.log('');
console.log(`${C.bold}text-to-SQL agent${C.off} ${C.dim}· provider ${providerName} · ${questions.length} questions${C.off}`);
console.log('');

if (flag('--ablate')) {
  // The ablation is the experiment: the same model and prompt, with the
  // feedback loop as the only variable.
  const single = await pass(1);
  const looped = await pass(attempts);

  console.log(`${C.bold}No repair (1 attempt)${C.off}      ${pct(single.report.executionAccuracy)}`);
  console.log(`${C.bold}With repair (${attempts} attempts)${C.off}   ${pct(looped.report.executionAccuracy)}`);
  const delta = looped.report.executionAccuracy - single.report.executionAccuracy;
  console.log('');
  console.log(delta > 0
    ? `${C.green}Self-correction recovered ${(delta * 100).toFixed(1)} points.${C.off}`
    : delta === 0
      ? `${C.dim}Self-correction changed nothing on this set.${C.off}`
      : `${C.red}Self-correction cost ${(-delta * 100).toFixed(1)} points.${C.off}`);

  const fixed = looped.predictions.filter((p) => p.agent.repaired);
  if (fixed.length) {
    console.log(`${C.dim}Repaired after a failed attempt:${C.off}`);
    for (const p of fixed) {
      const why = p.agent.attempts[0].error || p.agent.attempts[0].kind;
      console.log(`   ${C.dim}- ${p.id}: ${String(why).slice(0, 72)}${C.off}`);
    }
  }
  if (flag('--out')) writeFileSync(resolve(opt('--out', 'predictions.json')), JSON.stringify({ cases: looped.predictions }, null, 2));
  console.log('');
  process.exit(0);
}

const { predictions, report } = await pass(attempts);

for (const r of report.results) {
  const p = predictions.find((x) => x.id === r.id);
  const tag = r.execCorrect ? C.green + 'PASS' + C.off : C.red + 'FAIL' + C.off;
  const rep = p && p.agent.repaired ? C.yellow + ` repaired@${p.agent.attemptCount}` + C.off : '';
  console.log(` ${tag}  ${r.id.padEnd(26)} ${C.dim}${r.outcome}${C.off}${rep}`);
}

console.log('');
console.log(`${C.bold}Execution accuracy${C.off}  ${pct(report.executionAccuracy)}  ${C.dim}(${report.results.filter((r) => r.execCorrect).length}/${report.total})${C.off}`);
console.log(`${C.dim}Repaired: ${predictions.filter((p) => p.agent.repaired).length}  ·  never produced runnable SQL: ${predictions.filter((p) => !p.agent.ok).length}${C.off}`);

if (flag('--out')) {
  const out = resolve(opt('--out', 'predictions.json'));
  writeFileSync(out, JSON.stringify({ name: 'agent-run', cases: predictions }, null, 2));
  console.log(`${C.dim}Predictions written to ${out}${C.off}`);
}
console.log('');
