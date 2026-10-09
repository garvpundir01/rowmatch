# rowmatch

A text-to-SQL agent, and the execution-based harness that measures it.

The agent turns a question into SQL using schema linking and an execution-feedback
repair loop. The harness scores it by **running** the query and comparing result
sets, instead of comparing the two queries as strings.

```
npm test                 # 52 tests
npm run agent:ablate     # the repair loop, measured (scripted replies, no key)
npm run bench            # the evaluator on the hand-written benchmark
```

No required dependencies, no build step, no API keys to try it. SQLite comes from
`node:sqlite`. The Anthropic SDK is an optional dependency, loaded on demand.

---

## Part 1 — the agent

```
link schema -> prompt -> generate -> guard -> execute
                 ^                               |
                 +---------- feed the error -----+
```

A single generate-and-hope call is a prompt, not an agent. What makes this agentic
is that the environment answers back and the model gets to use the answer. A
database is an unusually good environment for that, because its errors are
precise, cheap, and truthful: `no such column: studnets` is better feedback than
any critic model.

**Schema linking** (`src/agent/schema.js`). A production database has hundreds of
tables. They do not fit in a prompt, and including irrelevant ones measurably hurts
accuracy, because the model picks a plausible-looking wrong table. So the agent
scores tables by token overlap with the question, takes the best few, then expands
one hop along foreign keys so a join target comes along even when the question
never names it. The scorer is lexical and deliberately legible: you can always say
why a table was included. Embedding similarity is the upgrade, and it drops into
`scoreTable` alone.

**Prompting** (`src/agent/prompt.js`). The schema is serialized as `CREATE TABLE`
text, which models read far better than a bullet list, plus two sample rows per
table so value formats are visible. Output is pinned to one bare statement, and
`extractSQL` still handles fenced blocks and leading prose, because
instruction-following is never perfect and a harness that trips over a code fence
is measuring its own parser.

**The repair loop** (`src/agent/agent.js`). Generate, guard, execute. On a refusal
or a database error, the error text goes back verbatim and the model tries again,
up to `maxAttempts`. Three deliberate choices:

- **Provider failures break the loop** instead of retrying. A connection reset is
  not repairable by prompting.
- **Empty results are accepted by default.** "No rows" is a correct answer to
  plenty of questions, so retrying on empty trades one error class for another.
  It is behind `retryOnEmpty` so the tradeoff can be measured, not assumed.
- **The loop cannot fix a query that runs and returns confidently wrong rows**,
  because nothing in the environment objects to those. That failure mode is
  exactly what Part 2 measures, which is why both halves live in one repository.

### Measured

`--ablate` runs the same model and prompt twice, with the loop as the only
variable:

```
No repair (1 attempt)      85.7%
With repair (3 attempts)   100.0%

Self-correction recovered 14.3 points.
Repaired after a failed attempt:
   - q13-syntax-error: incomplete input
   - q14-unsafe: starts with DROP, not a query
```

**That run uses scripted replies, not a model** — it exists so the loop is
reproducible with no key. For a real number, point it at a provider:

```bash
npm install @anthropic-ai/sdk
export ANTHROPIC_API_KEY=...          # never committed
node bin/agent.js --provider anthropic --ablate

node bin/agent.js --provider ollama --model qwen2.5-coder:7b --ablate   # local, free
```

The provider is an interface (`src/agent/provider.js`), which is why the entire
loop is testable without a network, a key, or a model behaving a particular way
today. A loop you can only exercise by spending money is a loop nobody tests.

---

## Part 2 — the evaluator

Most text-to-SQL work scores a prediction by string-matching it against a gold
query. That marks semantically **correct** SQL wrong whenever it is phrased
differently. On the included 14-case benchmark:

| Metric | Score |
|---|---|
| **Execution accuracy** | **50.0%** (7/14) |
| Exact-match accuracy | 7.1% (1/14) |

**String matching under-reports accuracy by 42.9 points.** Six predictions
returned exactly the right rows and were scored wrong for their wording:

```
q02-count-alias     SELECT COUNT(1) AS n FROM students s WHERE s.gpa > 3.5
                    vs  SELECT COUNT(*) FROM students WHERE gpa > 3.5

q04-in-vs-exists    EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = c.id)
                    vs  id IN (SELECT course_id FROM enrollments)

q05-between         year BETWEEN 2 AND 3   vs   year >= 2 AND year <= 3
```

The gap runs one way only: no prediction matched textually while returning the
wrong rows. That is asserted as a test, because the reverse would mean the
baseline is unsound rather than merely strict, and the comparison would be
worthless.

### Why this is harder than "run both and diff"

Four judgments, each of which silently changes the score if you get it wrong.

**Order.** SQL result sets are unordered unless the query says otherwise.
Comparing as sequences fails a correct answer whenever the engine returned rows in
another order; comparing as sets passes a wrong answer when the question actually
asked for a ranking. Order is significant only when the gold query has a
*top-level* `ORDER BY` — one inside a subquery does not fix the outer order, and
the string `'order by'` inside a literal is not a clause. Both are tested.

**Duplicates.** Sets are the wrong model. `SELECT dept FROM students` returning one
row per student is not the same answer as one row per department. Rows are
compared as a **multiset**.

**Names.** `COUNT(*)` and `COUNT(*) AS total` are the same answer, so columns are
compared by position and only values are compared.

**Types.** SQLite is dynamically typed; an aggregate comes back as `3`, `3.0` or
`"3"` depending on how it was written. Values are canonicalised, with floats
compared on a fixed grid so `0.1 + 0.2` equals `0.3`. Coercing numeric strings is a
real judgment call — `"007"` must not become `7` — so it is a documented default
with `--strict-types` to turn it off, not a silent assumption.

### Predicted SQL is untrusted input

The harness runs text a model wrote, against a database, on your machine. A model
emitting `DROP TABLE students` is not hypothetical; it is a plausible decoding
failure, and a harness that runs it corrupts the benchmark it is measuring.

Only a single read-only query is admitted. The check is literal-aware:
`SELECT 'drop table'` is fine, `SELECT 1; DROP TABLE t` is not, and neither is a
writable CTE. Each case also runs against a database built fresh from the schema,
so nothing leaks between cases. There is a test that runs the destructive case and
then proves the table survived.

### Failure taxonomy

One aggregate score says a model is 50% right. It does not say whether it is
writing broken SQL or subtly wrong SQL, which are different problems with
different fixes. Each case gets exactly one label:

| Outcome | Meaning |
|---|---|
| `correct` | Result set matches the gold query |
| `blocked_unsafe` | Refused before execution: not a single read-only query |
| `syntax_error` | The database rejected the prediction |
| `wrong_column_count` | Returned a different number of columns |
| `missing_rows` / `extra_rows` | Row counts disagree — usually a dropped predicate or join condition |
| `wrong_order` | Right rows, wrong sequence, on an ordered question |
| `wrong_values` | Same shape, different values |
| `gold_failed` | The gold query itself did not run — a broken benchmark case |

`gold_failed` exits non-zero. A benchmark whose own gold queries fail measures
nothing, and that should break CI rather than quietly lower the score.

---

## Evaluating your own model

`bench/cases.json` is the whole interface:

```json
{
  "cases": [
    {
      "id": "q01",
      "question": "How many students have a GPA above 3.5?",
      "gold": "SELECT COUNT(*) FROM students WHERE gpa > 3.5",
      "prediction": "SELECT COUNT(1) AS n FROM students s WHERE s.gpa > 3.5",
      "expect": "correct"
    }
  ]
}
```

```bash
node bin/rowmatch.js my-cases.json --schema my-schema.sql
node bin/agent.js --provider anthropic --out predictions.json   # generate, then score
```

`expect` is optional and used by the tests to hold the benchmark to its own
declared behaviour, so a case that starts behaving differently fails CI instead of
quietly moving the headline number.

## Layout

```
src/agent/provider.js   model interface: mock, Anthropic (SDK), Ollama
src/agent/schema.js     introspection, serialization, schema linking
src/agent/prompt.js     prompt construction, repair turns, SQL extraction
src/agent/agent.js      the generate -> guard -> execute -> repair loop
src/guard.js            admits only single read-only queries; literal-aware
src/execute.js          fresh in-memory database per case, result capture
src/compare.js          result-set equivalence: order, multiset, position, type
src/normalize.js        the exact-match baseline, in its most charitable form
src/evaluate.js         the harness and the metrics
bin/agent.js            agent CLI, with --ablate
bin/rowmatch.js         evaluator CLI and report
bench/                  schema, seed data, 14 cases, scripted mock replies
test/                   52 tests
```

## Limitations

- **The benchmark is small and hand-written.** 14 cases spanning the failure modes
  a model actually produces. It demonstrates the method and the size of the
  effect; it is not a claim about any model's accuracy. Real numbers need Spider
  or BIRD, which this harness accepts in the format above.
- **Schema linking is lexical, not learned.** It is a legible baseline that fails
  on questions sharing no vocabulary with the schema ("who teaches the most
  people?" against a `instructors`/`enrollments` schema). Embeddings fix that.
- **No wall-clock timeout.** `node:sqlite` is synchronous, so a pathological query
  cannot be interrupted from JavaScript. Mitigated by the read-only guard, a row
  cap and small databases; a subprocess-per-case harness would fix it properly.
- **SQLite, not Postgres.** The comparator is engine-agnostic; the executor is not.
- **Execution accuracy has its own blind spot.** A prediction can return the right
  rows for the wrong reason — on a small database, `WHERE id < 100` and
  `WHERE dept_id = 1` may coincide. Larger, more adversarial data narrows this; no
  execution-based metric eliminates it. It is the standard trade: exact match has
  false negatives, execution accuracy has false positives, and the second kind is
  rarer and less damaging.
