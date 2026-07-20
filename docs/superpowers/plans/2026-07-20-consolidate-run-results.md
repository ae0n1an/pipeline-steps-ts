# Consolidate Run Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new pipeline step, `consolidate-run-results`, that folds a named list of prior steps' outputs from the current run's `ctx.steps` into one structured JSON artifact, designed for trending over time and as the direct input for the (separately specced) Confluence publish step.

**Architecture:** The simplest step in this feature set — no file I/O beyond the final write, no network calls, no concurrency model, since `StepContext.steps` (already populated by the runner) has everything needed. A pure function `buildConsolidatedResult(config, steps, now?)` does all the logic; `runAll(config, ctx)` is a thin wrapper that calls it and writes the artifact; `defineStep` wraps `runAll` for the default export.

**Tech Stack:** TypeScript, `tsx --test` / `node:test` / `node:assert/strict`. No new dependencies.

## Global Constraints

- No new npm dependencies.
- `npm run typecheck` (tsc --noEmit) must pass after every task that touches `.ts` files.
- A step name in `config.stepNames` **not present at all** in `ctx.steps` is a hard error, thrown immediately, naming every missing step name.
- A step **present** in `ctx.steps` with `ok: false` is included normally as a failed entry — this must NOT throw. `consolidate-run-results` needs to succeed even when steps it's reporting on failed.
- All of a named step's `outputs` are pulled wholesale — no per-field selection.
- `runMetadata` is a plain passthrough object — the step has no built-in Azure DevOps–specific knowledge.
- `StepResult.outputs` (per `runner/types.ts`) carries only `consolidatedPath`, `totalSteps`, `succeededCount`, `failedCount` — no per-entry `name`-prefixing convention, since this step produces exactly one consolidated file per invocation.
- Test command for this feature: `npx tsx --test steps/consolidate-run-results.test.ts`.

---

## File Structure

- **Create:** `steps/consolidate-run-results.ts` — the step module (types, pure consolidation logic, orchestration, default export).
- **Create:** `steps/consolidate-run-results.test.ts` — unit tests, built up across Tasks 1–2.
- **Create:** `configs/consolidate-run-results.json` — example config.
- **Modify:** `.pipelines/azure-pipelines.yml` — add the step as the last step in the `Deliver` stage's `ship_data` job, with `condition: always()`.
- **Modify:** `README.md` — Layout/configs listings, a new `## Running` example.

---

### Task 1: Config types and consolidation logic

**Files:**
- Create: `steps/consolidate-run-results.ts`
- Create: `steps/consolidate-run-results.test.ts`

**Interfaces:**
- Produces: `ConsolidateRunResultsConfig { stepNames: string[]; runMetadata?: Record<string,string>; fileName?: string }`; `ConsolidatedStepEntry { stepName: string; ok: boolean; outputs: Record<string, string|number|boolean>; error?: string }`; `ConsolidatedResult { runMetadata: Record<string,string>; generatedAt: string; steps: ConsolidatedStepEntry[]; summary: { totalSteps: number; succeededCount: number; failedCount: number } }`; `buildConsolidatedResult(config: ConsolidateRunResultsConfig, steps: Record<string, StepOutputFile>, now?: () => string): ConsolidatedResult` (throws if `stepNames` empty or references a step not present in `steps`).

- [ ] **Step 1: Write the failing tests**

Create `steps/consolidate-run-results.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsolidatedResult } from './consolidate-run-results';
import type { StepOutputFile } from '../runner/types';

function fakeStepOutput(overrides: Partial<StepOutputFile> = {}): StepOutputFile {
  return {
    step: 'x',
    ok: true,
    durationMs: 10,
    outputs: {},
    artifacts: [],
    ...overrides,
  };
}

test('buildConsolidatedResult includes each named step with its outputs and ok status', () => {
  const steps = {
    genUsersCsv: fakeStepOutput({ ok: true, outputs: { usersCsv_rowCount: 250 } }),
  };
  const result = buildConsolidatedResult({ stepNames: ['genUsersCsv'] }, steps, () => '2026-07-20T00:00:00.000Z');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].stepName, 'genUsersCsv');
  assert.equal(result.steps[0].ok, true);
  assert.deepEqual(result.steps[0].outputs, { usersCsv_rowCount: 250 });
  assert.equal(result.steps[0].error, undefined);
  assert.equal(result.generatedAt, '2026-07-20T00:00:00.000Z');
});

test('buildConsolidatedResult includes a failed step with its error message, not throwing', () => {
  const steps = {
    extractAdfDetails: fakeStepOutput({ ok: false, outputs: {}, error: { message: 'boom', stack: 'at ...' } }),
  };
  const result = buildConsolidatedResult({ stepNames: ['extractAdfDetails'] }, steps);
  assert.equal(result.steps[0].ok, false);
  assert.equal(result.steps[0].error, 'boom');
});

test('buildConsolidatedResult computes summary counts correctly', () => {
  const steps = {
    a: fakeStepOutput({ ok: true }),
    b: fakeStepOutput({ ok: false, error: { message: 'e' } }),
    c: fakeStepOutput({ ok: true }),
  };
  const result = buildConsolidatedResult({ stepNames: ['a', 'b', 'c'] }, steps);
  assert.deepEqual(result.summary, { totalSteps: 3, succeededCount: 2, failedCount: 1 });
});

test('buildConsolidatedResult passes runMetadata through as-is, defaulting to an empty object', () => {
  const steps = { a: fakeStepOutput() };
  const withMeta = buildConsolidatedResult({ stepNames: ['a'], runMetadata: { buildId: '123' } }, steps);
  assert.deepEqual(withMeta.runMetadata, { buildId: '123' });
  const withoutMeta = buildConsolidatedResult({ stepNames: ['a'] }, steps);
  assert.deepEqual(withoutMeta.runMetadata, {});
});

test("buildConsolidatedResult throws naming every step not present in this run's step outputs", () => {
  const steps = { a: fakeStepOutput() };
  assert.throws(
    () => buildConsolidatedResult({ stepNames: ['a', 'missing1', 'missing2'] }, steps),
    /missing1, missing2/,
  );
});

test('buildConsolidatedResult throws when config.stepNames is empty', () => {
  assert.throws(
    () => buildConsolidatedResult({ stepNames: [] }, {}),
    /config\.stepNames must contain at least one step name/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/consolidate-run-results.test.ts`
Expected: FAIL — `steps/consolidate-run-results.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write the implementation**

Create `steps/consolidate-run-results.ts`:

```ts
/**
 * Step: consolidate-run-results (TypeScript)
 *
 * Folds a named list of prior steps' outputs from the current run into
 * one structured JSON artifact, designed for trending over time and as
 * the input for a later Confluence-publishing step. No file I/O or
 * network calls beyond the final write — StepContext.steps already has
 * everything needed, read from step-output/*/output.json by the runner.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult, type StepOutputFile } from '../runner/types';

export interface ConsolidateRunResultsConfig {
  stepNames: string[];
  /** Arbitrary key-value metadata, interpolated via {{env.VAR}} like any other config field. */
  runMetadata?: Record<string, string>;
  /** Output artifact filename; defaults to "run-results.json". */
  fileName?: string;
}

export interface ConsolidatedStepEntry {
  stepName: string;
  ok: boolean;
  outputs: Record<string, string | number | boolean>;
  error?: string;
}

export interface ConsolidatedResult {
  runMetadata: Record<string, string>;
  generatedAt: string;
  steps: ConsolidatedStepEntry[];
  summary: {
    totalSteps: number;
    succeededCount: number;
    failedCount: number;
  };
}

export function buildConsolidatedResult(
  config: ConsolidateRunResultsConfig,
  steps: Record<string, StepOutputFile>,
  now: () => string = () => new Date().toISOString(),
): ConsolidatedResult {
  if (!config.stepNames || config.stepNames.length === 0) {
    throw new Error('config.stepNames must contain at least one step name');
  }

  const missing = config.stepNames.filter(name => !(name in steps));
  if (missing.length > 0) {
    throw new Error(`Step(s) not found in this run's step outputs: ${missing.join(', ')}`);
  }

  const entries: ConsolidatedStepEntry[] = config.stepNames.map(stepName => {
    const stepOutput = steps[stepName];
    const entry: ConsolidatedStepEntry = {
      stepName,
      ok: stepOutput.ok,
      outputs: stepOutput.outputs ?? {},
    };
    if (stepOutput.error) entry.error = stepOutput.error.message;
    return entry;
  });

  const succeededCount = entries.filter(e => e.ok).length;

  return {
    runMetadata: config.runMetadata ?? {},
    generatedAt: now(),
    steps: entries,
    summary: {
      totalSteps: entries.length,
      succeededCount,
      failedCount: entries.length - succeededCount,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/consolidate-run-results.test.ts`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Unused imports `fs`, `path`, `defineStep`, `StepContext`, `StepResult` are fine at this point — Task 2 uses them, and this repo's tsconfig doesn't set `noUnusedLocals`.)

- [ ] **Step 6: Commit**

```bash
git add steps/consolidate-run-results.ts steps/consolidate-run-results.test.ts
git commit -m "feat: add config types and consolidation logic for consolidate-run-results step"
```

---

### Task 2: Orchestration and step export

**Files:**
- Modify: `steps/consolidate-run-results.ts`
- Modify: `steps/consolidate-run-results.test.ts`

**Interfaces:**
- Consumes: `buildConsolidatedResult`, `ConsolidateRunResultsConfig` from Task 1 (same file).
- Produces: `runAll(config: ConsolidateRunResultsConfig, ctx: StepContext): StepResult`; the module's `default` export (a `StepModule<ConsolidateRunResultsConfig>` built with `defineStep`).

- [ ] **Step 1: Write the failing tests**

Append to `steps/consolidate-run-results.test.ts`:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './consolidate-run-results';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string, steps: Record<string, StepOutputFile>): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps, log: () => {}, warn: () => {} };
}

test('runAll writes the consolidated JSON artifact and returns summary outputs', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-test-'));
  try {
    const steps = {
      genUsersCsv: fakeStepOutput({ ok: true, outputs: { usersCsv_rowCount: 250 } }),
    };
    const config = { stepNames: ['genUsersCsv'] };
    const result = runAll(config, fakeCtx(outDir, steps));
    assert.equal(result.outputs?.totalSteps, 1);
    assert.equal(result.outputs?.succeededCount, 1);
    assert.equal(result.outputs?.failedCount, 0);
    const filePath = result.outputs?.consolidatedPath as string;
    assert.ok(fs.existsSync(filePath));
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.steps[0].stepName, 'genUsersCsv');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll uses a custom fileName when configured', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-test-'));
  try {
    const steps = { a: fakeStepOutput() };
    const result = runAll({ stepNames: ['a'], fileName: 'custom-report.json' }, fakeCtx(outDir, steps));
    assert.ok((result.outputs?.consolidatedPath as string).endsWith('custom-report.json'));
    assert.ok(fs.existsSync(path.join(outDir, 'custom-report.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll propagates a missing-step-name error without writing a file', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-test-'));
  try {
    assert.throws(
      () => runAll({ stepNames: ['missing'] }, fakeCtx(outDir, {})),
      /missing/,
    );
    assert.deepEqual(fs.readdirSync(outDir), []);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

Note: this appended block reuses the `fakeStepOutput` helper already defined earlier in the same file by Task 1 — do not redefine it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/consolidate-run-results.test.ts`
Expected: FAIL — `runAll` is not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `steps/consolidate-run-results.ts` (after `buildConsolidatedResult`):

```ts
export function runAll(config: ConsolidateRunResultsConfig, ctx: StepContext): StepResult {
  const result = buildConsolidatedResult(config, ctx.steps);

  const fileName = config.fileName ?? 'run-results.json';
  const filePath = path.join(ctx.outDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));

  ctx.log(
    `Consolidated ${result.summary.totalSteps} step(s): ${result.summary.succeededCount} succeeded, ${result.summary.failedCount} failed -> ${fileName}`,
  );

  return {
    outputs: {
      consolidatedPath: filePath,
      totalSteps: result.summary.totalSteps,
      succeededCount: result.summary.succeededCount,
      failedCount: result.summary.failedCount,
    },
    artifacts: [filePath],
  };
}

export default defineStep<ConsolidateRunResultsConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/consolidate-run-results.test.ts`
Expected: PASS — 9 tests total, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/consolidate-run-results.ts steps/consolidate-run-results.test.ts
git commit -m "feat: add runAll orchestration and default step export for consolidate-run-results"
```

---

### Task 3: Example config, YAML wiring, and README

**Files:**
- Create: `configs/consolidate-run-results.json`
- Modify: `.pipelines/azure-pipelines.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ConsolidateRunResultsConfig` from Task 1; the real step names already present in `.pipelines/azure-pipelines.yml` (`genUsersCsv`, `gpgEncryptCsv`, `triggerAdf`, `extractAdfDetails` from the `Generate` stage; `verifyResult`, `verifyRowCount`, `validateSchema`, `validateBusinessLogic` from the `Deliver` stage).

- [ ] **Step 1: Create the example config**

Create `configs/consolidate-run-results.json`:

```json
{
  "stepNames": [
    "genUsersCsv",
    "gpgEncryptCsv",
    "triggerAdf",
    "extractAdfDetails",
    "verifyResult",
    "verifyRowCount",
    "validateSchema",
    "validateBusinessLogic"
  ],
  "runMetadata": {
    "buildId": "{{env.BUILD_BUILDID}}",
    "branch": "{{env.BUILD_SOURCEBRANCH}}"
  }
}
```

- [ ] **Step 2: Add the new step to the YAML's Deliver stage**

In `.pipelines/azure-pipelines.yml`, the `Deliver` stage's `ship_data` job currently ends with a plain `script` step (`displayName: 'Read upstream JSON / pick up encrypted file'`). Add the new step after it, as the very last step in the job:

```yaml
          # ---- Step: consolidate this run's results for trending/reporting
          - script: >
              npx tsx runner/run-step.ts
              --step steps/consolidate-run-results.ts
              --config configs/consolidate-run-results.json
              --name consolidateResults
            name: consolidateResults
            displayName: 'Consolidate run results'
            condition: always()
            env:
              BUILD_BUILDID: $(Build.BuildId)
              BUILD_SOURCEBRANCH: $(Build.SourceBranch)
```

`condition: always()` is required here (not present on any other step in this file) so this step still runs even if an earlier step in the job failed — see the design spec's "YAML placement note."

- [ ] **Step 3: Update README.md**

Update the `Layout` section's `steps/` listing to add:

```
  consolidate-run-results.ts  # fold named steps' outputs into one JSON for trending/reporting
```

Update the `configs/` listing to add:

```
  consolidate-run-results.json
```

Add a new runnable example to the `## Running` section, after the existing `extract-adf-run-details` example:

```markdown
Consolidate run results (reads `ctx.steps`, so it must run after the steps
it names — no external auth needed):

\`\`\`bash
npx tsx runner/run-step.ts \
  --step steps/consolidate-run-results.ts \
  --config configs/consolidate-run-results.json \
  --name consolidateResults
\`\`\`
```

- [ ] **Step 4: Verify the new config parses and the full suite still passes**

Run:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/consolidate-run-results.json', 'utf8')))"
npm test
npm run typecheck
```
Expected: the `node -e` call prints the parsed object with no error; `npm test` shows all tests passing (9 new from this plan, plus the pre-existing suite — 103 tests as of this repo's last count — for 112 total); `npm run typecheck` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add configs/consolidate-run-results.json .pipelines/azure-pipelines.yml README.md
git commit -m "docs: wire consolidate-run-results step into pipeline YAML and README"
```
