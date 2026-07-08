# Trigger ADF Pipeline Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `trigger-adf-pipeline` step that triggers one or more Azure Data Factory pipeline runs in parallel (with caller-supplied parameters), polls each to completion, and fails the step if any run doesn't succeed.

**Architecture:** A new `steps/trigger-adf-pipeline.ts` module following the existing `defineStep<TConfig>()` contract (see `steps/gpg-encrypt-file.ts` for the pattern). Internally it's split into pure helpers (URL building, target resolution, terminal-status check), a dependency-injected network layer (`triggerRun`, `pollUntilTerminal`), and an orchestration layer (`runAll`) that fans out `Promise.all` over the configured pipelines. Auth is a bearer token fetched by an `AzureCLI@2` task in the YAML and mapped into the step's env, matching how `GPG_PUBLIC_KEY` is mapped in today.

**Tech Stack:** TypeScript, `tsx` (already a dependency, no new npm packages), Node's built-in `node:test` + `node:assert/strict` for unit tests (run via `tsx --test`, verified working with tsx v4.23.0 / Node v22.11.0), Node's global `fetch`.

## Global Constraints

- No new npm dependencies — the repo currently has only `tsx`, `typescript`, `@types/node` as devDependencies; ADF calls use Node's global `fetch` directly, not an SDK (per spec's Auth section).
- `npm run typecheck` (`tsc --noEmit`) must pass after every task that touches `.ts` files.
- Follow the existing step-file conventions: a header doc-comment, `defineStep<TConfig>()` default export, `StepResult.outputs` restricted to `Record<string, string | number | boolean>`.
- Test command for this feature: `npx tsx --test steps/trigger-adf-pipeline.test.ts`.

---

## File Structure

- **Create:** `steps/trigger-adf-pipeline.ts` — the step module (types, pure helpers, network layer, orchestration, default export).
- **Create:** `steps/trigger-adf-pipeline.test.ts` — unit tests, built up across Tasks 1–3, covering the pure helpers, network layer, and orchestration.
- **Modify:** `package.json` — add a `test` script.
- **Create:** `configs/trigger-adf-pipelines.json` — example config with two parallel pipeline runs.
- **Modify:** `.pipelines/azure-pipelines.yml` — add the `AzureCLI@2` token task and the new step invocation.
- **Modify:** `README.md` — document the new step under Layout/Running, matching the existing two entries.

---

### Task 1: Config types and pure helpers

**Files:**
- Create: `steps/trigger-adf-pipeline.ts`
- Test: `steps/trigger-adf-pipeline.test.ts`

**Interfaces:**
- Produces: `AdfPipelineRun`, `TriggerAdfPipelineConfig`, `AdfTarget` types; `resolveTarget(run: AdfPipelineRun, config: TriggerAdfPipelineConfig): AdfTarget` (throws `Error` if subscriptionId/resourceGroup/factoryName can't be resolved from run or config); `buildCreateRunUrl(target: AdfTarget, pipelineName: string): string`; `buildPollUrl(target: AdfTarget, runId: string): string`; `isTerminalStatus(status: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `steps/trigger-adf-pipeline.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTarget,
  buildCreateRunUrl,
  buildPollUrl,
  isTerminalStatus,
} from './trigger-adf-pipeline';

test('resolveTarget uses per-run fields when present', () => {
  const target = resolveTarget(
    { pipelineName: 'p', subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    { accessToken: 't', pipelines: [] },
  );
  assert.deepEqual(target, { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
});

test('resolveTarget falls back to top-level config defaults', () => {
  const target = resolveTarget(
    { pipelineName: 'p' },
    { accessToken: 't', pipelines: [], subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
  );
  assert.deepEqual(target, { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
});

test('resolveTarget throws when a coordinate is missing everywhere', () => {
  assert.throws(
    () => resolveTarget({ pipelineName: 'p' }, { accessToken: 't', pipelines: [], subscriptionId: 'sub1' }),
    /missing subscriptionId\/resourceGroup\/factoryName/,
  );
});

test('buildCreateRunUrl builds the ADF createRun endpoint', () => {
  const url = buildCreateRunUrl(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    'copyOrders',
  );
  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DataFactory/factories/f1/pipelines/copyOrders/createRun?api-version=2018-06-01',
  );
});

test('buildPollUrl builds the ADF pipelineruns endpoint', () => {
  const url = buildPollUrl(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    'run-123',
  );
  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DataFactory/factories/f1/pipelineruns/run-123?api-version=2018-06-01',
  );
});

test('isTerminalStatus recognizes terminal and non-terminal states', () => {
  assert.equal(isTerminalStatus('Succeeded'), true);
  assert.equal(isTerminalStatus('Failed'), true);
  assert.equal(isTerminalStatus('Cancelled'), true);
  assert.equal(isTerminalStatus('TimedOut'), true);
  assert.equal(isTerminalStatus('InProgress'), false);
  assert.equal(isTerminalStatus('Queued'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/trigger-adf-pipeline.test.ts`
Expected: FAIL — `steps/trigger-adf-pipeline.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write the implementation**

Create `steps/trigger-adf-pipeline.ts`:

```ts
/**
 * Step: trigger-adf-pipeline (TypeScript)
 *
 * Triggers one or more Azure Data Factory pipeline runs in parallel and
 * polls each to completion. Auth is a bearer token fetched by an
 * AzureCLI@2 task upstream in the pipeline YAML and mapped into this
 * step's env (config.accessToken -> "{{env.ADF_ACCESS_TOKEN}}").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';

const API_VERSION = '2018-06-01';
const TERMINAL_STATUSES = new Set(['Succeeded', 'Failed', 'Cancelled', 'TimedOut']);

// ---------- Config types --------------------------------------------------

export interface AdfPipelineRun {
  /** Friendly key used for this run's output fields; defaults to "p{index}". */
  name?: string;
  pipelineName: string;
  parameters?: Record<string, unknown>;
  /** Per-run overrides; fall back to the top-level config defaults. */
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export interface TriggerAdfPipelineConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** Poll interval while waiting for a run to finish. Default 15000. */
  pollIntervalMs?: number | string;
  /** Max time to wait for a single run before treating it as failed. Default 3600000 (1h). */
  timeoutMs?: number | string;
  pipelines: AdfPipelineRun[];
}

export interface AdfTarget {
  subscriptionId: string;
  resourceGroup: string;
  factoryName: string;
}

export interface RunResult {
  name: string;
  pipelineName: string;
  runId?: string;
  status: string;
  durationMs: number;
  message?: string;
}

// ---------- Pure helpers ---------------------------------------------------

export function resolveTarget(run: AdfPipelineRun, config: TriggerAdfPipelineConfig): AdfTarget {
  const subscriptionId = run.subscriptionId ?? config.subscriptionId;
  const resourceGroup = run.resourceGroup ?? config.resourceGroup;
  const factoryName = run.factoryName ?? config.factoryName;
  if (!subscriptionId || !resourceGroup || !factoryName) {
    throw new Error(
      `Pipeline run "${run.pipelineName}" is missing subscriptionId/resourceGroup/factoryName ` +
      '(set them per-run or as top-level config defaults)',
    );
  }
  return { subscriptionId, resourceGroup, factoryName };
}

export function buildCreateRunUrl(target: AdfTarget, pipelineName: string): string {
  return `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DataFactory/factories/${target.factoryName}/pipelines/${pipelineName}/createRun?api-version=${API_VERSION}`;
}

export function buildPollUrl(target: AdfTarget, runId: string): string {
  return `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DataFactory/factories/${target.factoryName}/pipelineruns/${runId}?api-version=${API_VERSION}`;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/trigger-adf-pipeline.test.ts`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Unused imports `fs`, `path`, `StepContext`, `StepResult`, `defineStep` are fine at this point — Task 3 uses them; `tsc --noEmit` with this repo's config does not fail on unused-but-imported symbols. If it does, remove the not-yet-used imports here and re-add them in Task 3.)

- [ ] **Step 6: Commit**

```bash
git add steps/trigger-adf-pipeline.ts steps/trigger-adf-pipeline.test.ts
git commit -m "feat: add config types and pure helpers for trigger-adf-pipeline step"
```

---

### Task 2: Network layer (trigger + poll)

**Files:**
- Modify: `steps/trigger-adf-pipeline.ts`
- Modify: `steps/trigger-adf-pipeline.test.ts`

**Interfaces:**
- Consumes: `AdfTarget`, `AdfPipelineRun`, `buildCreateRunUrl`, `buildPollUrl`, `isTerminalStatus` from Task 1.
- Produces: `FetchLike` type (subset of the Fetch API used: `(url, init?) => Promise<{ ok, status, json(), text() }>`); `AdfDeps` type (`{ fetchImpl: FetchLike; sleepImpl: (ms: number) => Promise<void>; nowImpl: () => number }`); `defaultDeps: AdfDeps`; `triggerRun(target: AdfTarget, run: AdfPipelineRun, accessToken: string, fetchImpl: FetchLike): Promise<string>` (returns `runId`, throws on non-2xx or missing `runId`); `pollUntilTerminal(target: AdfTarget, runId: string, accessToken: string, opts: { pollIntervalMs: number; timeoutMs: number }, deps: AdfDeps): Promise<{ status: string; message?: string }>`.

- [ ] **Step 1: Write the failing tests**

Append to `steps/trigger-adf-pipeline.test.ts` (add to the existing imports and add these tests):

```ts
import { triggerRun, pollUntilTerminal, type AdfDeps, type FetchLike } from './trigger-adf-pipeline';

function fakeClock(overrides: Partial<AdfDeps> = {}): AdfDeps {
  let clock = 0;
  return {
    fetchImpl: overrides.fetchImpl ?? (async () => { throw new Error('fetchImpl not stubbed'); }),
    sleepImpl: overrides.sleepImpl ?? (async (ms: number) => { clock += ms; }),
    nowImpl: overrides.nowImpl ?? (() => clock),
  };
}

test('triggerRun posts parameters and returns runId', async () => {
  let capturedUrl = '';
  let capturedBody = '';
  const fetchImpl: FetchLike = async (url, init) => {
    capturedUrl = url;
    capturedBody = init?.body ?? '';
    return { ok: true, status: 200, json: async () => ({ runId: 'run-abc' }), text: async () => '' };
  };
  const runId = await triggerRun(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    { pipelineName: 'copyOrders', parameters: { x: 1 } },
    'token-123',
    fetchImpl,
  );
  assert.equal(runId, 'run-abc');
  assert.match(capturedUrl, /pipelines\/copyOrders\/createRun/);
  assert.equal(capturedBody, JSON.stringify({ x: 1 }));
});

test('triggerRun throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: false,
    status: 403,
    json: async () => ({}),
    text: async () => 'Forbidden',
  });
  await assert.rejects(
    () => triggerRun({ subscriptionId: 's', resourceGroup: 'r', factoryName: 'f' }, { pipelineName: 'p' }, 't', fetchImpl),
    /HTTP 403[\s\S]*Forbidden/,
  );
});

test('pollUntilTerminal returns once status is terminal', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: calls < 3 ? 'InProgress' : 'Succeeded' }),
      text: async () => '',
    };
  };
  const deps = fakeClock({ fetchImpl });
  const outcome = await pollUntilTerminal(
    { subscriptionId: 's', resourceGroup: 'r', factoryName: 'f' },
    'run-1',
    't',
    { pollIntervalMs: 1000, timeoutMs: 60000 },
    deps,
  );
  assert.equal(outcome.status, 'Succeeded');
  assert.equal(calls, 3);
});

test('pollUntilTerminal times out and reports TimedOut', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'InProgress' }),
    text: async () => '',
  });
  const deps = fakeClock({ fetchImpl });
  const outcome = await pollUntilTerminal(
    { subscriptionId: 's', resourceGroup: 'r', factoryName: 'f' },
    'run-1',
    't',
    { pollIntervalMs: 1000, timeoutMs: 2500 },
    deps,
  );
  assert.equal(outcome.status, 'TimedOut');
});

test('pollUntilTerminal retries past a transient non-2xx response', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({}), text: async () => 'throttled' };
    return { ok: true, status: 200, json: async () => ({ status: 'Succeeded' }), text: async () => '' };
  };
  const deps = fakeClock({ fetchImpl });
  const outcome = await pollUntilTerminal(
    { subscriptionId: 's', resourceGroup: 'r', factoryName: 'f' },
    'run-1',
    't',
    { pollIntervalMs: 1000, timeoutMs: 60000 },
    deps,
  );
  assert.equal(outcome.status, 'Succeeded');
  assert.equal(calls, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/trigger-adf-pipeline.test.ts`
Expected: FAIL — `triggerRun`/`pollUntilTerminal`/`FetchLike`/`AdfDeps` are not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `steps/trigger-adf-pipeline.ts` (after the pure helpers section):

```ts
// ---------- Network layer (dependency-injected for testing) ---------------

export interface FetchLike {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;
}

export interface AdfDeps {
  fetchImpl: FetchLike;
  sleepImpl: (ms: number) => Promise<void>;
  nowImpl: () => number;
}

export const defaultDeps: AdfDeps = {
  fetchImpl: fetch as unknown as FetchLike,
  sleepImpl: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
  nowImpl: () => Date.now(),
};

export async function triggerRun(
  target: AdfTarget,
  run: AdfPipelineRun,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const res = await fetchImpl(buildCreateRunUrl(target, run.pipelineName), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(run.parameters ?? {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`createRun failed for "${run.pipelineName}" (HTTP ${res.status}): ${body}`);
  }
  const data = await res.json();
  if (!data.runId) throw new Error(`createRun response for "${run.pipelineName}" had no runId`);
  return data.runId as string;
}

export async function pollUntilTerminal(
  target: AdfTarget,
  runId: string,
  accessToken: string,
  opts: { pollIntervalMs: number; timeoutMs: number },
  deps: AdfDeps,
): Promise<{ status: string; message?: string }> {
  const startedAt = deps.nowImpl();
  for (;;) {
    if (deps.nowImpl() - startedAt >= opts.timeoutMs) {
      return { status: 'TimedOut', message: `Polling exceeded timeoutMs=${opts.timeoutMs}` };
    }
    const res = await deps.fetchImpl(buildPollUrl(target, runId), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (isTerminalStatus(data.status)) {
        return { status: data.status, message: data.message };
      }
    }
    await deps.sleepImpl(opts.pollIntervalMs);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/trigger-adf-pipeline.test.ts`
Expected: PASS — 11 tests total, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/trigger-adf-pipeline.ts steps/trigger-adf-pipeline.test.ts
git commit -m "feat: add ADF trigger/poll network layer with injectable deps"
```

---

### Task 3: Orchestration and step export

**Files:**
- Modify: `steps/trigger-adf-pipeline.ts`
- Modify: `steps/trigger-adf-pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2 (`resolveTarget`, `triggerRun`, `pollUntilTerminal`, `AdfDeps`, `defaultDeps`, `RunResult`, `TriggerAdfPipelineConfig`, `AdfPipelineRun`).
- Produces: `runAll(config: TriggerAdfPipelineConfig, ctx: StepContext, deps?: AdfDeps): Promise<StepResult>`; the module's `default` export (a `StepModule<TriggerAdfPipelineConfig>` built with `defineStep`).

- [ ] **Step 1: Write the failing tests**

Append to `steps/trigger-adf-pipeline.test.ts`:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './trigger-adf-pipeline';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return {
    stepName: 'test',
    outDir,
    workspace: outDir,
    steps: {},
    log: () => {},
    warn: () => {},
  };
}

test('runAll triggers and polls all pipelines, returns flattened outputs', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adf-test-'));
  try {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('createRun')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ runId: url.includes('copyA') ? 'run-a' : 'run-b' }),
          text: async () => '',
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'Succeeded' }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pipelines: [
        { name: 'copyA', pipelineName: 'copyA' },
        { pipelineName: 'copyB' },
      ],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(result.outputs?.totalPipelines, 2);
    assert.equal(result.outputs?.succeededCount, 2);
    assert.equal(result.outputs?.failedCount, 0);
    assert.equal(result.outputs?.copyA_status, 'Succeeded');
    assert.equal(result.outputs?.copyA_runId, 'run-a');
    assert.equal(result.outputs?.p1_status, 'Succeeded');
    assert.equal(result.outputs?.p1_pipelineName, 'copyB');
    assert.ok(fs.existsSync(path.join(outDir, 'run-summary.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws an aggregated error when any pipeline does not succeed', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adf-test-'));
  try {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('createRun')) {
        return { ok: true, status: 200, json: async () => ({ runId: 'run-x' }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'Failed', message: 'boom' }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pipelines: [{ pipelineName: 'copyC' }],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), deps),
      /1\/1 ADF pipeline run\(s\) did not succeed[\s\S]*copyC[\s\S]*Failed/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll validates required config upfront', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adf-test-'));
  try {
    await assert.rejects(
      () => runAll({ accessToken: '', pipelines: [] } as any, fakeCtx(outDir), fakeClock()),
      /accessToken is required/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', pipelines: [] }, fakeCtx(outDir), fakeClock()),
      /at least one pipeline run/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', pipelines: [{ pipelineName: '' }] } as any, fakeCtx(outDir), fakeClock()),
      /missing pipelineName/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/trigger-adf-pipeline.test.ts`
Expected: FAIL — `runAll` is not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `steps/trigger-adf-pipeline.ts` (after the network layer section):

```ts
// ---------- Orchestration ---------------------------------------------------

function outputKeyPrefix(run: AdfPipelineRun, index: number): string {
  return run.name ?? `p${index}`;
}

async function runOnePipeline(
  run: AdfPipelineRun,
  index: number,
  config: TriggerAdfPipelineConfig,
  deps: AdfDeps,
  ctx: StepContext,
): Promise<RunResult> {
  const name = outputKeyPrefix(run, index);
  const startedAt = deps.nowImpl();
  try {
    const target = resolveTarget(run, config);
    const runId = await triggerRun(target, run, config.accessToken, deps.fetchImpl);
    ctx.log(`Triggered "${run.pipelineName}" (${name}) -> runId=${runId}`);
    const outcome = await pollUntilTerminal(
      target,
      runId,
      config.accessToken,
      {
        pollIntervalMs: Number(config.pollIntervalMs ?? 15000),
        timeoutMs: Number(config.timeoutMs ?? 3600000),
      },
      deps,
    );
    return {
      name,
      pipelineName: run.pipelineName,
      runId,
      status: outcome.status,
      durationMs: deps.nowImpl() - startedAt,
      message: outcome.message,
    };
  } catch (err) {
    return {
      name,
      pipelineName: run.pipelineName,
      status: 'Failed',
      durationMs: deps.nowImpl() - startedAt,
      message: (err as Error).message,
    };
  }
}

export async function runAll(
  config: TriggerAdfPipelineConfig,
  ctx: StepContext,
  deps: AdfDeps = defaultDeps,
): Promise<StepResult> {
  if (!config.accessToken) throw new Error('config.accessToken is required');
  if (!config.pipelines || config.pipelines.length === 0) {
    throw new Error('config.pipelines must contain at least one pipeline run');
  }
  config.pipelines.forEach((run, i) => {
    if (!run.pipelineName) throw new Error(`config.pipelines[${i}] is missing pipelineName`);
  });

  const results = await Promise.all(
    config.pipelines.map((run, index) => runOnePipeline(run, index, config, deps, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'run-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const outputs: Record<string, string | number | boolean> = {
    totalPipelines: results.length,
    succeededCount: results.filter(r => r.status === 'Succeeded').length,
    failedCount: results.filter(r => r.status !== 'Succeeded').length,
  };
  for (const r of results) {
    outputs[`${r.name}_runId`] = r.runId ?? '';
    outputs[`${r.name}_status`] = r.status;
    outputs[`${r.name}_pipelineName`] = r.pipelineName;
    outputs[`${r.name}_durationMs`] = r.durationMs;
  }

  const failed = results.filter(r => r.status !== 'Succeeded');
  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.pipelineName}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} ADF pipeline run(s) did not succeed:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<TriggerAdfPipelineConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/trigger-adf-pipeline.test.ts`
Expected: PASS — 14 tests total, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/trigger-adf-pipeline.ts steps/trigger-adf-pipeline.test.ts
git commit -m "feat: add runAll orchestration and default step export for trigger-adf-pipeline"
```

---

### Task 4: Wire up the npm test script and run the full suite

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: `steps/trigger-adf-pipeline.test.ts` from Tasks 1–3.
- Produces: `npm test` script usable for this and any future step's `*.test.ts` files.

- [ ] **Step 1: Add the test script**

In `package.json`, add `"test"` alongside the existing `"typecheck"` / `"step"` scripts:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "step": "tsx runner/run-step.ts",
    "test": "tsx --test steps/**/*.test.ts"
  }
}
```

- [ ] **Step 2: Run the full suite via the new script**

Run: `npm test`
Expected: PASS — all 14 tests from `steps/trigger-adf-pipeline.test.ts`, 0 failures.

- [ ] **Step 3: Run typecheck once more for the whole repo**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add npm test script for step unit tests"
```

---

### Task 5: Example config, YAML wiring, and README

**Files:**
- Create: `configs/trigger-adf-pipelines.json`
- Modify: `.pipelines/azure-pipelines.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `steps/trigger-adf-pipeline.ts`'s config shape from Task 1 (`TriggerAdfPipelineConfig`); the runner's existing `--step`/`--config`/`--name` CLI contract (`runner/run-step.ts`).

- [ ] **Step 1: Create the example config**

Create `configs/trigger-adf-pipelines.json`:

```json
{
  "accessToken": "{{env.ADF_ACCESS_TOKEN}}",
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "resourceGroup": "my-resource-group",
  "factoryName": "my-data-factory",
  "pollIntervalMs": 15000,
  "timeoutMs": 3600000,
  "pipelines": [
    {
      "name": "copyOrders",
      "pipelineName": "CopyOrdersPipeline",
      "parameters": { "sourcePath": "{{steps.genUsersCsv.outputs.csvPath}}" }
    },
    {
      "name": "copyInvoices",
      "pipelineName": "CopyInvoicesPipeline",
      "parameters": { "runDate": "{{env.BUILD_SOURCEVERSIONDATE}}" }
    }
  ]
}
```

- [ ] **Step 2: Add the AzureCLI@2 token task and step invocation to the YAML**

In `.pipelines/azure-pipelines.yml`, inside the `build_data` job of the `Generate` stage, add a new task after the existing `AzureKeyVault@2` task (around line 36) and a new script step after the `gpgEncryptCsv` step (around line 54), before `PublishPipelineArtifact@1`:

```yaml
          # ---- Fetch an ARM access token for the ADF management API -----
          - task: AzureCLI@2
            displayName: 'Fetch ADF access token'
            inputs:
              azureSubscription: 'my-service-connection'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              inlineScript: |
                TOKEN=$(az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv)
                echo "##vso[task.setvariable variable=adfAccessToken;issecret=true]$TOKEN"

          # ---- Step 3: trigger ADF pipelines in parallel, poll to done -
          - script: >
              npx tsx runner/run-step.ts
              --step steps/trigger-adf-pipeline.ts
              --config configs/trigger-adf-pipelines.json
              --name triggerAdf
            name: triggerAdf
            displayName: 'Trigger ADF pipelines'
            env:
              ADF_ACCESS_TOKEN: $(adfAccessToken)
```

- [ ] **Step 3: Document the step in README.md**

In `README.md`, update the `Layout` section's `steps/` listing (around line 13-15) to add a third line:

```
  generate-synthetic-csv.ts   # mock CSV from typed column configs
  gpg-encrypt-file.ts         # GPG-encrypt with a key from Azure Key Vault
  trigger-adf-pipeline.ts     # trigger + poll ADF pipeline run(s) in parallel
```

And update the `configs/` listing (around line 16-18) to add:

```
  generate-users-csv.json
  gpg-encrypt-users-csv.json
  trigger-adf-pipelines.json
```

Then add a new subsection after the existing `## Running` code block (after line 60), before the `No build/dist step` paragraph:

```markdown
Trigger ADF pipelines (needs an ARM access token — see the `AzureCLI@2` task
in `.pipelines/azure-pipelines.yml`, or `az account get-access-token
--resource https://management.azure.com/` locally):

```bash
export ADF_ACCESS_TOKEN="$(az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv)"
npx tsx runner/run-step.ts \
  --step steps/trigger-adf-pipeline.ts \
  --config configs/trigger-adf-pipelines.json \
  --name triggerAdf
```
```

Also add a line to `## How outputs flow` → step 2 (pipeline output variables), noting the per-pipeline naming, right after the existing `gpgEncryptCsv` example (around line 72):

```
   `$(genUsersCsv.genUsersCsv.rowCount)` or via `stageDependencies`. For
   `trigger-adf-pipeline`, each pipeline run's outputs are prefixed by its
   configured `name` (or `p0`, `p1`, … by index), e.g.
   `$(triggerAdf.triggerAdf.copyOrders_status)`.
```

- [ ] **Step 4: Verify the new config parses and the step module loads**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('configs/trigger-adf-pipelines.json', 'utf8')))"`
Expected: prints the parsed config object, no error.

Run: `npx tsc --noEmit`
Expected: no errors (confirms the YAML/README edits didn't break anything and the example config's shape is consistent — this is a text/YAML check via typecheck of the surrounding project, not of the YAML itself, but ensures nothing in the .ts files broke).

- [ ] **Step 5: Commit**

```bash
git add configs/trigger-adf-pipelines.json .pipelines/azure-pipelines.yml README.md
git commit -m "docs: wire trigger-adf-pipeline step into pipeline YAML and README"
```

---

## Post-plan note: this directory is not a git repository

`git status` in `/Users/maxverhoef/ClaudeProjects/pipeline-steps-ts` currently reports "not a git repository." Every commit step above will fail until `git init` (or cloning into an existing repo) happens. Before Task 1's commit step, run `git init` and make an initial commit of the pre-existing files (`README.md`, `runner/`, `steps/`, `configs/`, `.pipelines/`, `package.json`, `tsconfig.json`) if the user confirms that's desired — otherwise skip all commit steps and leave changes unstaged.
