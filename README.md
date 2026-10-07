# rowmatch

Execution-based evaluation for text-to-SQL. It runs the predicted query and the
gold query against a real database and compares the result sets, instead of
comparing the two strings.

```
npm test                 # 35 tests
npm run bench            # evaluate the included benchmark
npm run bench:json       # the same, as JSON for CI
```

No dependencies, no build step, no API keys. SQLite comes from `node:sqlite`.

## The result

On the included 14-case benchmark:

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

Every one of those is the same question, correctly answered, in different words.
A metric that calls them failures is measuring phrasing, not correctness.

The gap runs one way only: no prediction matched textually while returning the
wrong rows. That is asserted as a test, because the reverse would mean the
baseline is unsound rather than merely strict, and the whole comparison would be
worthless.

## Why this is harder than "run both and diff"

Result-set equivalence needs four judgments, and getting any of them wrong
silently changes the score.

**Order.** SQL result sets are unordered unless the query says otherwise.
Comparing as sequences fails a correct answer whenever the engine returned rows
in another order; comparing as sets passes a wrong answer when the question
actually asked for a ranking. rowmatch treats order as significant only when the
gold query has a *top-level* `ORDER BY` — one inside a subquery doesn't fix the
outer order, and the string `'order by'` inside a literal isn't a clause at all.
Both are tested.

**Duplicates.** Sets are the wrong model. `SELECT dept FROM students` returning
one row per student is not the same answer as one row per department. Rows are
compared as a **multiset**.

**Names.** `COUNT(*)` and `COUNT(*) AS total` are the same answer, so columns
are compared by position and only values are compared.

**Types.** SQLite is dynamically typed; an aggregate comes back as `3`, `3.0` or
`"3"` depending on how it was written. Values are canonicalised, with float
comparison on a fixed grid so `0.1 + 0.2` and `0.3` agree. Coercing numeric
strings is a real judgment call — a zero-padded code like `"007"` must not
become `7` — so it is a documented default with `--strict-types` to turn it off,
not a silent assumption.

## Predicted SQL is untrusted input

A harness runs text a model wrote, against a database, on your machine. A model
emitting `DROP TABLE students` is not hypothetical; it is a plausible decoding
failure. A harness that runs it corrupts the benchmark it is measuring, and
every case after it scores against a mutilated database.

So predictions are admitted only as a single read-only query. The check is
literal-aware: `SELECT 'drop table'` is admissible, `SELECT 1; DROP TABLE t` is
not, and neither is a writable CTE. Anything refused is scored as a failure,
which is the honest outcome — a model that cannot produce a `SELECT` did not
answer the question.

Each case also gets a database built fresh from the schema, so a prediction
cannot affect a later case even if it slips past the guard. There is a test that
runs the destructive case and then proves the table is still there.

## Failure taxonomy

A single aggregate score tells you a model is 50% right. It doesn't tell you
whether it is writing broken SQL or subtly wrong SQL — which are different
problems with different fixes. Each case gets exactly one label:

| Outcome | Meaning |
|---|---|
| `correct` | Result set matches the gold query |
| `blocked_unsafe` | Refused before execution: not a single read-only query |
| `syntax_error` | The database rejected the prediction |
| `wrong_column_count` | Returned a different number of columns |
| `missing_rows` / `extra_rows` | Row counts disagree — usually a dropped predicate or join condition |
| `wrong_order` | Right rows, wrong sequence, on an ordered question |
| `wrong_values` | Same shape, different values |
| `gold_failed` | The gold query itself didn't run — a broken benchmark case |

`gold_failed` exits non-zero. A benchmark whose own gold queries fail measures
nothing, and that should break a CI job rather than quietly lower the score.

## Evaluating your own model

`bench/cases.json` is the whole interface. Generate predictions however you
like, write them into the `prediction` field, and run:

```bash
node bin/rowmatch.js my-cases.json --schema my-schema.sql
```

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

`expect` is optional and used by the test suite to hold the benchmark to its own
declared behaviour, so a case that starts behaving differently fails CI instead
of quietly moving the headline number.

## Layout

```
src/guard.js      admits only single read-only queries; literal-aware
src/execute.js    fresh in-memory database per case, result capture
src/compare.js    result-set equivalence — order, multiset, position, type
src/normalize.js  the exact-match baseline, in its most charitable form
src/evaluate.js   the harness and the metrics
bin/rowmatch.js   CLI and report
bench/            schema, seed data, and 14 cases
test/             35 tests
```

The baseline is implemented generously on purpose — comments stripped,
whitespace collapsed, case folded outside literals, redundant outer parentheses
removed. The measured gap is therefore a floor, not an artifact of a
deliberately weak comparison.

## Limitations

- **The benchmark is small and hand-written.** 14 cases with predictions chosen
  to span the failure modes a model actually produces. It demonstrates the
  method and the size of the effect; it is not a claim about any model's
  accuracy. Real numbers need Spider or BIRD, which this harness accepts in the
  format above.
- **No wall-clock timeout.** `node:sqlite` is synchronous, so a pathological
  query cannot be interrupted from JavaScript. Mitigated by the read-only guard,
  a row cap, and small benchmark databases — but a hostile prediction could
  still spin. A subprocess-per-case harness would fix it.
- **SQLite, not Postgres.** Dialect differences matter: `BETWEEN`, string
  concatenation and date functions all vary. The comparator is engine-agnostic;
  the executor is not.
- **Execution accuracy has its own blind spot.** A prediction can return the
  right rows for the wrong reason — on a small database, `WHERE id < 100` and
  `WHERE dept_id = 1` may coincide. Larger and more adversarial data narrows
  this, but no execution-based metric eliminates it. It is the standard trade:
  exact match has false negatives, execution accuracy has false positives, and
  the second kind is rarer and less damaging.
