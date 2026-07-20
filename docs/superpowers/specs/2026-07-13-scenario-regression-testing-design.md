# Scenario Regression Testing — Design

## Purpose

Add a golden-file regression testing layer, distinct from the existing
`steps/*.test.ts` unit tests. Where the unit tests exercise a single
step's logic in isolation against a fake/injected client, this layer
runs a small declarative "scenario" — one or more chained step
invocations — through the *real* runner CLI, exactly as
`.pipelines/azure-pipelines.yml` does, and diffs the normalized result
against a checked-in golden file. It exists to catch unintended changes
to generated output (e.g. the RNG or generation logic silently producing
different bytes for a pinned seed) and to make it cheap to grow a wide
library of "inbound schema" variants as fixtures without writing new test
code for each one.

## Structure

A new top-level `test/` directory, separate from `steps/`, since this
suite tests end-to-end CLI invocation of chained steps against real
generated files — a different kind of test from the fake-client unit
tests already living under `steps/`.

```
test/
  scenarios/                    # one fixture per scenario
    basic-users.json
    sparse-nulls.json
    sequence-ids.json
    custom-headers.json
    generate-then-verify.json
  golden/                       # one golden result per scenario, checked into git
    basic-users.json
    sparse-nulls.json
    sequence-ids.json
    custom-headers.json
    generate-then-verify.json
  lib/
    scenario-harness.ts         # run / normalize / compare / update logic
  scenarios.test.ts             # discovers fixtures, one node:test per scenario
```

## Scenario file shape

```ts
export interface ScenarioStep {
  /** Path to the step module, relative to repo root, e.g. "steps/generate-synthetic-csv.ts". */
  step: string;
  /** The step's config — same shape as any configs/*.json file. */
  config: unknown;
  /** Output key prefix; matches the runner's --name. */
  name: string;
}

export interface Scenario {
  description?: string;
  steps: ScenarioStep[];
}
```

A scenario is a small ordered list of step invocations, not just a
`generate-synthetic-csv` config — this lets a scenario chain e.g.
`generate-synthetic-csv` → `validate-json-schema` to prove multi-step
composition works, not just single-step generation.

## Execution: shell out to the real runner CLI

For each scenario:

1. Create a fresh scratch directory, used as `PIPELINE_WORKSPACE` for
   every step in this scenario (so `step-output/` accumulates across the
   scenario's steps the same way it does in the real pipeline job).
2. For each `ScenarioStep`, write its `config` to a temp JSON file (not
   passed inline as a CLI arg, to avoid argument-length/escaping
   concerns) and spawn:
   ```
   npx tsx runner/run-step.ts --step <step> --config <tmpfile> --name <name>
   ```
   with `PIPELINE_WORKSPACE` set to the scenario's scratch directory.
3. This is the exact mechanism `.pipelines/azure-pipelines.yml` uses, so
   `{{steps.X.outputs.Y}}` interpolation between chained steps in one
   scenario works for free — `run-step.ts` already reads prior steps'
   `output.json` from the shared workspace before resolving a later
   step's config.

This was chosen over importing step modules and calling `run()`
in-process specifically because it also exercises the runner's own
config-interpolation/env-override logic, not just the step logic — the
thing this layer is meant to protect is "does this work through the same
mechanism production uses," not just "is the step's internal logic
correct" (that's what the unit tests are for).

## Normalization

Per step, `output.json` is reduced to a normalized form before either
comparing or writing to a golden file:

- **Kept:** `ok`, `outputs` (any absolute path values rewritten relative
  to the scenario's scratch workspace root), `artifacts` (same path
  rewrite, sorted), and a new `fileHashes` map — `{ [normalizedPath]:
  sha256HexDigest }` for every artifact file, computed by hashing the
  file's actual bytes.
- **Dropped:** `startedAt`, `durationMs` (non-deterministic), `config`
  (redundant echo of input already checked into the fixture file),
  `error.stack` (environment-dependent; `error.message` is kept if a
  step legitimately fails as part of a scenario — see Out of scope).

`fileHashes` is the main reason this design includes file hashing at all
(considered and rejected: outputs/artifacts-only comparison) — it is the
only way to catch a regression that changes cell *values* without
changing row count, column names, or any other structural output field.

## Golden file shape

One golden file per scenario, keyed by each step's `name`:

```json
{
  "genUsersCsv": {
    "ok": true,
    "outputs": {
      "usersCsv_rowCount": 5,
      "usersCsv_csvPath": "step-output/genUsersCsv/users.csv"
    },
    "artifacts": ["step-output/genUsersCsv/users.csv"],
    "fileHashes": {
      "step-output/genUsersCsv/users.csv": "sha256:3a7bd3e2360a3d..."
    }
  }
}
```

## Comparison and update flow

- **Default** (`npm run test:scenarios`): run the scenario, normalize
  each step's result, deep-compare against `test/golden/<scenario>.json`.
  - **No golden file exists:** the test **fails**, with a message
    telling the developer to run with `UPDATE_GOLDENS=1` — a missing
    golden is never auto-created on a plain run, so a buggy first run
    can't silently become the accepted baseline without a human
    reviewing it via `git diff`.
  - **Golden exists but doesn't match:** the test fails, printing which
    keys/hashes differ.
- **`UPDATE_GOLDENS=1 npm run test:scenarios`:** instead of comparing,
  writes the normalized result to the golden file (creating or
  overwriting) and passes, logging that the golden was (re)written. The
  developer is expected to review the resulting `git diff` before
  committing.

## CI wiring

`.pipelines/azure-pipelines.yml` gets one new step in the existing job,
immediately after the existing `npm run typecheck` step:

```yaml
- script: npm run test:scenarios
  displayName: 'Run scenario regression tests'
```

This is a **blocking** gate — a scenario regression fails the build, the
same way `npm run typecheck` and the existing `npm test` step already do.

## package.json

```json
"test:scenarios": "tsx --test \"test/**/*.test.ts\""
```

Kept separate from the existing `"test"` script (which stays scoped to
`steps/**/*.test.ts`) since this suite is slower by nature — real
subprocess spawns and file I/O per scenario, versus the existing suite's
fast in-process unit tests against fake clients.

## Starter scenario set

Five scenarios, chosen to exercise recent feature additions and prove the
harness's core mechanics:

1. `basic-users.json` — mirrors `configs/generate-users-csv.json`.
2. `sparse-nulls.json` — heavy `nullProbability` across multiple column
   types.
3. `sequence-ids.json` — exercises the `sequence` column type.
4. `custom-headers.json` — exercises the `header` field.
5. `generate-then-verify.json` — chains `generate-synthetic-csv` →
   `verify-row-count` in one scenario, proving multi-step scenario
   composition and `{{steps.X.outputs.Y}}` interpolation work through the
   harness end-to-end. (Not `validate-json-schema`: that step needs JSON
   input, and `generate-synthetic-csv` only produces CSV.)

## Out of scope

- **GPG/blob steps are not scenario-tested.** GPG ciphertext is
  non-deterministic (fresh keypair/nonce per encryption) and blob steps
  require live Azure credentials — neither is snapshot-friendly. These
  stay covered by their existing unit tests against fake clients
  (`createFakeBlobStorageClient`) or a real local `gpg` binary.
- **No fixture-generation DSL or matrix expansion.** Each scenario is a
  fully literal, hand-authored JSON file — no templating or parameterized
  scenario generation. If scenario authoring volume becomes a real
  problem, that's a separate follow-up, not part of this design.
- **No auto-created golden files, ever** — see Comparison and update
  flow above. This is a deliberate, permanent behavior, not a v1
  limitation.
- **Scenarios that are expected to fail** (i.e., a step in the scenario
  is expected to throw) are not explicitly designed for in this pass.
  All starter scenarios are expected to succeed end-to-end. If
  failure-scenario testing is wanted later, it needs its own design pass
  (e.g. an `expectFailure: true` flag on a `ScenarioStep`, and a decision
  about what "golden" means for a thrown error).
- **No parallel scenario execution** — scenarios run sequentially in
  `test/scenarios.test.ts`. With five starter scenarios this is not a
  performance concern; revisit if the scenario count grows large enough
  to matter.
