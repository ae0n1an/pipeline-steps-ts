# ADF Trigger/Poll/Wait Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `trigger-adf-pipeline.ts` into `execute-adf-pipeline.ts` (trigger-only) and `poll-adf-pipeline-runs.ts` (poll-only), and add `wait-for-adf-pipeline-trigger.ts` to detect whether an external scheduler (Control-M) already auto-triggered a pipeline before falling back to a manual trigger.

**Architecture:** A new `steps/lib/adf-client.ts` holds target resolution, ADF URL builders, `triggerRun`, and `pollUntilTerminal` — shared by all three trigger/poll/wait steps. Each step keeps the existing per-entry array + flattened-output convention (`{name}_field`, `name` defaults to `p{index}`). No step calls another step's code; the wait→execute chain is wired purely through config interpolation (`existingRunId`), so no YAML `condition:` is needed anywhere.

**Tech Stack:** TypeScript, `node:test`/`node:assert/strict`, `tsx`, existing `FetchLike`/`AdfDeps` dependency-injection pattern.

## Global Constraints

- Every new/changed step keeps the `name?` field (defaulting to `p{index}`) + flattened `{name}_*` output convention already used by every multi-entry step in this repo.
- `steps/lib/adf-client.ts` is used by `execute-adf-pipeline.ts`, `poll-adf-pipeline-runs.ts`, and `wait-for-adf-pipeline-trigger.ts` only. `extract-adf-run-details.ts` stays self-contained (existing, documented decision — do not touch it beyond its config file's runId source).
- `resolveTarget(entry, config, label)` in the shared lib takes an explicit `label` string for its error message (entry shapes differ across the three callers, so there's no single field to read a label from generically).
- `triggerRun`'s signature is `triggerRun(target, pipelineName, parameters, accessToken, fetchImpl)` — parameters passed separately, not nested in a run/entry object (differs from the current `trigger-adf-pipeline.ts`'s `triggerRun(target, run, accessToken, fetchImpl)`; this plan's version is the one to build).
- `wait-for-adf-pipeline-trigger.ts`'s `runAll` **never throws** for "no automatic trigger detected" — that is a normal outcome. It only throws for missing required config or a non-2xx HTTP response.
- `execute-adf-pipeline.ts`'s per-entry `status` is `'Triggered' | 'PassedThrough' | 'FailedToTrigger'` — it does not represent the pipeline's terminal run outcome (that is `poll-adf-pipeline-runs.ts`'s job).
- Defaults: `execute-adf-pipeline` has no polling config. `poll-adf-pipeline-runs`: `pollIntervalMs` 15000, `timeoutMs` 3600000. `wait-for-adf-pipeline-trigger`: `pollIntervalMs` 15000, `waitTimeoutMs` 600000.
- All ADF steps keep using `config.accessToken` sourced from `{{env.ADF_ACCESS_TOKEN}}` in configs, mapped from `$(adfAccessToken)` in YAML — same convention as today.
- Artifacts: `execute-adf-pipeline` → `execution-summary.json`; `poll-adf-pipeline-runs` → `poll-summary.json`; `wait-for-adf-pipeline-trigger` → `wait-summary.json`.

---

### Task 1: Shared ADF client library

**Files:**
- Create: `steps/lib/adf-client.ts`
- Test: `steps/lib/adf-client.test.ts`

**Interfaces:**
- Produces: `AdfTarget { subscriptionId, resourceGroup, factoryName }`; `AdfTargetSource { subscriptionId?, resourceGroup?, factoryName? }`; `resolveTarget(entry: AdfTargetSource, config: AdfTargetSource, label: string): AdfTarget`; `FetchLike`; `AdfDeps { fetchImpl, sleepImpl, nowImpl }`; `defaultDeps: AdfDeps`; `buildCreateRunUrl(target, pipelineName): string`; `buildPollUrl(target, runId): string`; `buildQueryPipelineRunsUrl(target): string`; `isTerminalStatus(status): boolean`; `triggerRun(target, pipelineName, parameters, accessToken, fetchImpl): Promise<string>`; `pollUntilTerminal(target, runId, accessToken, opts, deps): Promise<{status, message?}>`.

- [ ] **Step 1: Write `steps/lib/adf-client.ts`**

```ts
/**
 * Shared Azure Data Factory REST client used by execute-adf-pipeline,
 * poll-adf-pipeline-runs, and wait-for-adf-pipeline-trigger. Not shared
 * with extract-adf-run-details.ts — see that step's file header for why;
 * the overlap there (URL prefix, auth header) is too small to justify
 * touching already-shipped, tested code.
 */

const API_VERSION = '2018-06-01';
const TERMINAL_STATUSES = new Set(['Succeeded', 'Failed', 'Cancelled', 'TimedOut']);

export interface AdfTarget {
  subscriptionId: string;
  resourceGroup: string;
  factoryName: string;
}

export interface AdfTargetSource {
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export function resolveTarget(entry: AdfTargetSource, config: AdfTargetSource, label: string): AdfTarget {
  const subscriptionId = entry.subscriptionId ?? config.subscriptionId;
  const resourceGroup = entry.resourceGroup ?? config.resourceGroup;
  const factoryName = entry.factoryName ?? config.factoryName;
  if (!subscriptionId || !resourceGroup || !factoryName) {
    throw new Error(
      `"${label}" is missing subscriptionId/resourceGroup/factoryName ` +
      '(set them per-entry or as top-level config defaults)',
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

export function buildQueryPipelineRunsUrl(target: AdfTarget): string {
  return `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DataFactory/factories/${target.factoryName}/queryPipelineRuns?api-version=${API_VERSION}`;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

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
  pipelineName: string,
  parameters: Record<string, unknown> | undefined,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const res = await fetchImpl(buildCreateRunUrl(target, pipelineName), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(parameters ?? {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`createRun failed for "${pipelineName}" (HTTP ${res.status}): ${body}`);
  }
  const data = await res.json();
  if (!data.runId) throw new Error(`createRun response for "${pipelineName}" had no runId`);
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

- [ ] **Step 2: Write `steps/lib/adf-client.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTarget,
  buildCreateRunUrl,
  buildPollUrl,
  buildQueryPipelineRunsUrl,
  isTerminalStatus,
  triggerRun,
  pollUntilTerminal,
  type AdfDeps,
  type FetchLike,
} from './adf-client';

test('resolveTarget uses per-entry fields when present', () => {
  const target = resolveTarget(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    {},
    'copyOrders',
  );
  assert.deepEqual(target, { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
});

test('resolveTarget falls back to top-level config defaults', () => {
  const target = resolveTarget(
    {},
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    'copyOrders',
  );
  assert.deepEqual(target, { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
});

test('resolveTarget throws naming the entry when a coordinate is missing everywhere', () => {
  assert.throws(
    () => resolveTarget({}, { subscriptionId: 'sub1' }, 'copyOrders'),
    /"copyOrders" is missing subscriptionId\/resourceGroup\/factoryName/,
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

test('buildQueryPipelineRunsUrl builds the factory-scoped queryPipelineRuns endpoint', () => {
  const url = buildQueryPipelineRunsUrl({ subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DataFactory/factories/f1/queryPipelineRuns?api-version=2018-06-01',
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
    'copyOrders',
    { x: 1 },
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
    () => triggerRun({ subscriptionId: 's', resourceGroup: 'r', factoryName: 'f' }, 'p', undefined, 't', fetchImpl),
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

- [ ] **Step 3: Run the tests**

Run: `npx tsx --test steps/lib/adf-client.test.ts`
Expected: all tests pass (13 tests).

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add steps/lib/adf-client.ts steps/lib/adf-client.test.ts
git commit -m "feat: add shared ADF client library for execute/poll/wait steps"
```

---

### Task 2: `execute-adf-pipeline` step

**Files:**
- Create: `steps/execute-adf-pipeline.ts`
- Test: `steps/execute-adf-pipeline.test.ts`

**Interfaces:**
- Consumes: `resolveTarget`, `triggerRun`, `AdfDeps`, `defaultDeps` from `./lib/adf-client` (Task 1).
- Produces: `AdfPipelineExecution { name?, pipelineName, parameters?, subscriptionId?, resourceGroup?, factoryName?, existingRunId? }`; `ExecuteAdfPipelineConfig { accessToken, subscriptionId?, resourceGroup?, factoryName?, pipelines: AdfPipelineExecution[] }`; `runAll(config, ctx, deps?): Promise<StepResult>`. Later tasks reference this step's outputs as `{name}_runId` / `{name}_status`.

- [ ] **Step 1: Write `steps/execute-adf-pipeline.ts`**

```ts
/**
 * Step: execute-adf-pipeline (TypeScript)
 *
 * Triggers one or more Azure Data Factory pipeline runs in parallel and
 * returns immediately with each run's runId — no polling. Split out of
 * the former trigger-adf-pipeline.ts; poll-adf-pipeline-runs.ts now owns
 * polling to completion. An entry with existingRunId set skips triggering
 * entirely and passes that runId through, so this step can sit downstream
 * of wait-for-adf-pipeline-trigger without a YAML condition: to skip it.
 *
 * Auth is a bearer token fetched by an AzureCLI@2 task upstream in the
 * pipeline YAML and mapped into this step's env
 * (config.accessToken -> "{{env.ADF_ACCESS_TOKEN}}").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import { resolveTarget, triggerRun, type AdfDeps, defaultDeps } from './lib/adf-client';

// ---------- Config types --------------------------------------------------

export interface AdfPipelineExecution {
  /** Friendly key used for this entry's output fields; defaults to "p{index}". */
  name?: string;
  pipelineName: string;
  parameters?: Record<string, unknown>;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** If set (non-empty), skip triggering and pass this runId through as-is. */
  existingRunId?: string;
}

export interface ExecuteAdfPipelineConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  pipelines: AdfPipelineExecution[];
}

export interface ExecutionResult {
  name: string;
  pipelineName: string;
  runId?: string;
  status: 'Triggered' | 'PassedThrough' | 'FailedToTrigger';
  message?: string;
}

// ---------- Orchestration ---------------------------------------------------

function outputKeyPrefix(entry: AdfPipelineExecution, index: number): string {
  return entry.name ?? `p${index}`;
}

async function runOnePipeline(
  entry: AdfPipelineExecution,
  index: number,
  config: ExecuteAdfPipelineConfig,
  deps: AdfDeps,
  ctx: StepContext,
): Promise<ExecutionResult> {
  const name = outputKeyPrefix(entry, index);

  if (entry.existingRunId) {
    ctx.log(`"${entry.pipelineName}" (${name}) already triggered automatically -> runId=${entry.existingRunId}, passing through`);
    return {
      name,
      pipelineName: entry.pipelineName,
      runId: entry.existingRunId,
      status: 'PassedThrough',
    };
  }

  try {
    const target = resolveTarget(entry, config, entry.pipelineName);
    const runId = await triggerRun(target, entry.pipelineName, entry.parameters, config.accessToken, deps.fetchImpl);
    ctx.log(`Triggered "${entry.pipelineName}" (${name}) -> runId=${runId}`);
    return { name, pipelineName: entry.pipelineName, runId, status: 'Triggered' };
  } catch (err) {
    return {
      name,
      pipelineName: entry.pipelineName,
      status: 'FailedToTrigger',
      message: (err as Error).message,
    };
  }
}

export async function runAll(
  config: ExecuteAdfPipelineConfig,
  ctx: StepContext,
  deps: AdfDeps = defaultDeps,
): Promise<StepResult> {
  if (!config.accessToken) throw new Error('config.accessToken is required');
  if (!config.pipelines || config.pipelines.length === 0) {
    throw new Error('config.pipelines must contain at least one pipeline run');
  }
  config.pipelines.forEach((entry, i) => {
    if (!entry.pipelineName) throw new Error(`config.pipelines[${i}] is missing pipelineName`);
  });

  const results = await Promise.all(
    config.pipelines.map((entry, index) => runOnePipeline(entry, index, config, deps, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'execution-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status === 'FailedToTrigger');
  const outputs: Record<string, string | number | boolean> = {
    totalPipelines: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  for (const r of results) {
    outputs[`${r.name}_runId`] = r.runId ?? '';
    outputs[`${r.name}_status`] = r.status;
    outputs[`${r.name}_pipelineName`] = r.pipelineName;
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.pipelineName}): ${r.message ?? 'unknown error'}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} ADF pipeline(s) failed to trigger:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<ExecuteAdfPipelineConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 2: Write `steps/execute-adf-pipeline.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './execute-adf-pipeline';
import type { FetchLike, AdfDeps } from './lib/adf-client';
import type { StepContext } from '../runner/types';

function fakeClock(overrides: Partial<AdfDeps> = {}): AdfDeps {
  let clock = 0;
  return {
    fetchImpl: overrides.fetchImpl ?? (async () => { throw new Error('fetchImpl not stubbed'); }),
    sleepImpl: overrides.sleepImpl ?? (async (ms: number) => { clock += ms; }),
    nowImpl: overrides.nowImpl ?? (() => clock),
  };
}

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('runAll triggers pipelines and returns flattened outputs, no polling', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-adf-test-'));
  try {
    const fetchImpl: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({ runId: url.includes('copyA') ? 'run-a' : 'run-b' }),
      text: async () => '',
    });
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
    assert.equal(result.outputs?.copyA_status, 'Triggered');
    assert.equal(result.outputs?.copyA_runId, 'run-a');
    assert.equal(result.outputs?.p1_pipelineName, 'copyB');
    assert.ok(fs.existsSync(path.join(outDir, 'execution-summary.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll passes existingRunId through without calling createRun', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-adf-test-'));
  try {
    let createRunCalls = 0;
    const fetchImpl: FetchLike = async () => {
      createRunCalls += 1;
      return { ok: true, status: 200, json: async () => ({ runId: 'should-not-happen' }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pipelines: [{ name: 'copyA', pipelineName: 'copyA', existingRunId: 'run-auto-1' }],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(createRunCalls, 0);
    assert.equal(result.outputs?.copyA_runId, 'run-auto-1');
    assert.equal(result.outputs?.copyA_status, 'PassedThrough');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws an aggregated error when a pipeline fails to trigger', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-adf-test-'));
  try {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'Forbidden' });
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
      /1\/1 ADF pipeline\(s\) failed to trigger[\s\S]*copyC[\s\S]*HTTP 403/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll validates required config upfront', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-adf-test-'));
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

- [ ] **Step 3: Run the tests**

Run: `npx tsx --test steps/execute-adf-pipeline.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add steps/execute-adf-pipeline.ts steps/execute-adf-pipeline.test.ts
git commit -m "feat: add execute-adf-pipeline step (trigger-only, with existingRunId pass-through)"
```

---

### Task 3: `poll-adf-pipeline-runs` step

**Files:**
- Create: `steps/poll-adf-pipeline-runs.ts`
- Test: `steps/poll-adf-pipeline-runs.test.ts`

**Interfaces:**
- Consumes: `resolveTarget`, `pollUntilTerminal`, `AdfDeps`, `defaultDeps` from `./lib/adf-client` (Task 1).
- Produces: `AdfRunToPoll { name?, runId, pipelineName?, subscriptionId?, resourceGroup?, factoryName? }`; `PollAdfPipelineRunsConfig { accessToken, subscriptionId?, resourceGroup?, factoryName?, pollIntervalMs?, timeoutMs?, runs: AdfRunToPoll[] }`; `runAll(config, ctx, deps?): Promise<StepResult>`. Outputs `{name}_runId` / `{name}_status` — Task 5's YAML/config wiring feeds `runs[].runId` from `execute-adf-pipeline`'s `{name}_runId` output.

- [ ] **Step 1: Write `steps/poll-adf-pipeline-runs.ts`**

```ts
/**
 * Step: poll-adf-pipeline-runs (TypeScript)
 *
 * Polls a list of already-triggered Azure Data Factory pipeline runs (by
 * runId) to a terminal status, in parallel. Split out of the former
 * trigger-adf-pipeline.ts; execute-adf-pipeline.ts now owns triggering.
 *
 * Auth is a bearer token fetched by an AzureCLI@2 task upstream in the
 * pipeline YAML and mapped into this step's env
 * (config.accessToken -> "{{env.ADF_ACCESS_TOKEN}}").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import { resolveTarget, pollUntilTerminal, type AdfDeps, defaultDeps } from './lib/adf-client';

// ---------- Config types --------------------------------------------------

export interface AdfRunToPoll {
  /** Friendly key used for this entry's output fields; defaults to "p{index}". */
  name?: string;
  runId: string;
  /** Optional, informational only — passed through to this entry's output if supplied, not used in any API call. */
  pipelineName?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export interface PollAdfPipelineRunsConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** Poll interval while waiting for a run to finish. Default 15000. */
  pollIntervalMs?: number | string;
  /** Max time to wait for a single run before treating it as failed. Default 3600000 (1h). */
  timeoutMs?: number | string;
  runs: AdfRunToPoll[];
}

export interface PollResult {
  name: string;
  runId: string;
  pipelineName?: string;
  status: string;
  durationMs: number;
  message?: string;
}

// ---------- Orchestration ---------------------------------------------------

function outputKeyPrefix(entry: AdfRunToPoll, index: number): string {
  return entry.name ?? `p${index}`;
}

async function pollOneRun(
  entry: AdfRunToPoll,
  index: number,
  config: PollAdfPipelineRunsConfig,
  deps: AdfDeps,
  ctx: StepContext,
): Promise<PollResult> {
  const name = outputKeyPrefix(entry, index);
  const startedAt = deps.nowImpl();
  try {
    const target = resolveTarget(entry, config, entry.runId);
    const outcome = await pollUntilTerminal(
      target,
      entry.runId,
      config.accessToken,
      {
        pollIntervalMs: Number(config.pollIntervalMs ?? 15000),
        timeoutMs: Number(config.timeoutMs ?? 3600000),
      },
      deps,
    );
    ctx.log(`Polled run "${entry.runId}" (${name}) -> ${outcome.status}`);
    return {
      name,
      runId: entry.runId,
      pipelineName: entry.pipelineName,
      status: outcome.status,
      durationMs: deps.nowImpl() - startedAt,
      message: outcome.message,
    };
  } catch (err) {
    return {
      name,
      runId: entry.runId,
      pipelineName: entry.pipelineName,
      status: 'Failed',
      durationMs: deps.nowImpl() - startedAt,
      message: (err as Error).message,
    };
  }
}

export async function runAll(
  config: PollAdfPipelineRunsConfig,
  ctx: StepContext,
  deps: AdfDeps = defaultDeps,
): Promise<StepResult> {
  if (!config.accessToken) throw new Error('config.accessToken is required');
  if (!config.runs || config.runs.length === 0) {
    throw new Error('config.runs must contain at least one run');
  }
  config.runs.forEach((entry, i) => {
    if (!entry.runId) throw new Error(`config.runs[${i}] is missing runId`);
  });

  const results = await Promise.all(
    config.runs.map((entry, index) => pollOneRun(entry, index, config, deps, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'poll-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status !== 'Succeeded');
  const outputs: Record<string, string | number | boolean> = {
    totalPipelines: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  for (const r of results) {
    outputs[`${r.name}_runId`] = r.runId;
    outputs[`${r.name}_status`] = r.status;
    if (r.pipelineName !== undefined) outputs[`${r.name}_pipelineName`] = r.pipelineName;
    outputs[`${r.name}_durationMs`] = r.durationMs;
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (runId=${r.runId}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} ADF pipeline run(s) did not succeed:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<PollAdfPipelineRunsConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 2: Write `steps/poll-adf-pipeline-runs.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './poll-adf-pipeline-runs';
import type { FetchLike, AdfDeps } from './lib/adf-client';
import type { StepContext } from '../runner/types';

function fakeClock(overrides: Partial<AdfDeps> = {}): AdfDeps {
  let clock = 0;
  return {
    fetchImpl: overrides.fetchImpl ?? (async () => { throw new Error('fetchImpl not stubbed'); }),
    sleepImpl: overrides.sleepImpl ?? (async (ms: number) => { clock += ms; }),
    nowImpl: overrides.nowImpl ?? (() => clock),
  };
}

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('runAll polls all runs to completion, returns flattened outputs', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-adf-test-'));
  try {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ status: 'Succeeded' }), text: async () => '' });
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      runs: [
        { name: 'copyA', runId: 'run-a', pipelineName: 'copyA' },
        { runId: 'run-b' },
      ],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(result.outputs?.totalPipelines, 2);
    assert.equal(result.outputs?.succeededCount, 2);
    assert.equal(result.outputs?.failedCount, 0);
    assert.equal(result.outputs?.copyA_status, 'Succeeded');
    assert.equal(result.outputs?.copyA_pipelineName, 'copyA');
    assert.equal(result.outputs?.p1_status, 'Succeeded');
    assert.equal(result.outputs?.p1_runId, 'run-b');
    assert.equal(result.outputs?.p1_pipelineName, undefined);
    assert.ok(fs.existsSync(path.join(outDir, 'poll-summary.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws an aggregated error when any run does not succeed', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-adf-test-'));
  try {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ status: 'Failed', message: 'boom' }), text: async () => '' });
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      runs: [{ runId: 'run-x', pipelineName: 'copyC' }],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), deps),
      /1\/1 ADF pipeline run\(s\) did not succeed[\s\S]*run-x[\s\S]*Failed/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll polls a mixed batch to completion: one success does not abort a sibling failure', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-adf-test-'));
  try {
    let goodPolls = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('run-good')) {
        goodPolls += 1;
        return { ok: true, status: 200, json: async () => ({ status: 'Succeeded' }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'Failed', message: 'boom' }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      runs: [
        { name: 'copyGood', runId: 'run-good' },
        { name: 'copyBad', runId: 'run-bad' },
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), deps),
      /1\/2 ADF pipeline run\(s\) did not succeed[\s\S]*copyBad[\s\S]*run-bad[\s\S]*Failed/,
    );
    assert.equal(goodPolls, 1);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'poll-summary.json'), 'utf8'));
    assert.equal(summary.find((r: { name: string }) => r.name === 'copyGood').status, 'Succeeded');
    assert.equal(summary.find((r: { name: string }) => r.name === 'copyBad').status, 'Failed');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll times out a run that never reaches a terminal status', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-adf-test-'));
  try {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ status: 'InProgress' }), text: async () => '' });
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pollIntervalMs: 1000,
      timeoutMs: 2500,
      runs: [{ runId: 'run-x' }],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), deps),
      /1\/1 ADF pipeline run\(s\) did not succeed[\s\S]*TimedOut/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll validates required config upfront', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-adf-test-'));
  try {
    await assert.rejects(
      () => runAll({ accessToken: '', runs: [] } as any, fakeCtx(outDir), fakeClock()),
      /accessToken is required/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', runs: [] }, fakeCtx(outDir), fakeClock()),
      /at least one run/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', runs: [{ runId: '' }] } as any, fakeCtx(outDir), fakeClock()),
      /missing runId/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the tests**

Run: `npx tsx --test steps/poll-adf-pipeline-runs.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add steps/poll-adf-pipeline-runs.ts steps/poll-adf-pipeline-runs.test.ts
git commit -m "feat: add poll-adf-pipeline-runs step (poll-only)"
```

---

### Task 4: `wait-for-adf-pipeline-trigger` step

**Files:**
- Create: `steps/wait-for-adf-pipeline-trigger.ts`
- Test: `steps/wait-for-adf-pipeline-trigger.test.ts`

**Interfaces:**
- Consumes: `resolveTarget`, `buildQueryPipelineRunsUrl`, `AdfTarget`, `AdfDeps`, `FetchLike`, `defaultDeps` from `./lib/adf-client` (Task 1).
- Produces: `AdfPipelineWait { name?, pipelineName, subscriptionId?, resourceGroup?, factoryName? }`; `WaitForAdfPipelineTriggerConfig { accessToken, subscriptionId?, resourceGroup?, factoryName?, pollIntervalMs?, waitTimeoutMs?, pipelines: AdfPipelineWait[] }`; `findAutoTriggeredRun(target, pipelineName, window, accessToken, fetchImpl): Promise<string | undefined>`; `runAll(config, ctx, deps?): Promise<StepResult>`. Outputs `{name}_triggered` / `{name}_runId` — Task 5's config wiring feeds `execute-adf-pipeline`'s `pipelines[].existingRunId` from this step's `{name}_runId` output.

- [ ] **Step 1: Write `steps/wait-for-adf-pipeline-trigger.ts`**

```ts
/**
 * Step: wait-for-adf-pipeline-trigger (TypeScript)
 *
 * Waits to see whether an external scheduler (e.g. Control-M) has already
 * triggered an Azure Data Factory pipeline automatically, by polling ADF's
 * queryPipelineRuns for a matching run started after this step began. If
 * no run appears within waitTimeoutMs, reports triggered:false so the
 * pipeline can fall back to manually triggering it (execute-adf-pipeline.ts)
 * — this supports testing that Control-M's automatic triggers actually
 * fire, with a manual fallback when they don't.
 *
 * Auth is a bearer token fetched by an AzureCLI@2 task upstream in the
 * pipeline YAML and mapped into this step's env
 * (config.accessToken -> "{{env.ADF_ACCESS_TOKEN}}").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import {
  resolveTarget,
  buildQueryPipelineRunsUrl,
  type AdfTarget,
  type AdfDeps,
  type FetchLike,
  defaultDeps,
} from './lib/adf-client';

// ---------- Config types --------------------------------------------------

export interface AdfPipelineWait {
  /** Friendly key used for this entry's output fields; defaults to "p{index}". */
  name?: string;
  pipelineName: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export interface WaitForAdfPipelineTriggerConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** How often to re-check queryPipelineRuns while waiting. Default 15000. */
  pollIntervalMs?: number | string;
  /** Max time to wait for an automatic trigger before falling back. Default 600000 (10 min). */
  waitTimeoutMs?: number | string;
  pipelines: AdfPipelineWait[];
}

export interface WaitResult {
  name: string;
  pipelineName: string;
  triggered: boolean;
  runId: string;
  waitedMs: number;
}

// ---------- queryPipelineRuns lookup ----------------------------------------

interface RawPipelineRunSummary {
  runId: string;
}

export async function findAutoTriggeredRun(
  target: AdfTarget,
  pipelineName: string,
  window: { lastUpdatedAfter: string; lastUpdatedBefore: string },
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const res = await fetchImpl(buildQueryPipelineRunsUrl(target), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...window,
      filters: [{ operand: 'PipelineName', operator: 'Equals', values: [pipelineName] }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`queryPipelineRuns failed for "${pipelineName}" (HTTP ${res.status}): ${body}`);
  }
  const data = await res.json();
  const runs = (data.value ?? []) as RawPipelineRunSummary[];
  return runs[0]?.runId;
}

// ---------- Orchestration ---------------------------------------------------

function outputKeyPrefix(entry: AdfPipelineWait, index: number): string {
  return entry.name ?? `p${index}`;
}

async function waitForOnePipeline(
  entry: AdfPipelineWait,
  index: number,
  config: WaitForAdfPipelineTriggerConfig,
  deps: AdfDeps,
  ctx: StepContext,
): Promise<WaitResult> {
  const name = outputKeyPrefix(entry, index);
  const target = resolveTarget(entry, config, entry.pipelineName);
  const pollIntervalMs = Number(config.pollIntervalMs ?? 15000);
  const waitTimeoutMs = Number(config.waitTimeoutMs ?? 600000);

  const startedAt = deps.nowImpl();
  const lastUpdatedAfter = new Date(startedAt - 60_000).toISOString();

  for (;;) {
    const elapsed = deps.nowImpl() - startedAt;
    const lastUpdatedBefore = new Date(deps.nowImpl() + 60_000).toISOString();
    const runId = await findAutoTriggeredRun(
      target,
      entry.pipelineName,
      { lastUpdatedAfter, lastUpdatedBefore },
      config.accessToken,
      deps.fetchImpl,
    );
    if (runId) {
      ctx.log(`Detected automatic trigger for "${entry.pipelineName}" (${name}) -> runId=${runId}`);
      return { name, pipelineName: entry.pipelineName, triggered: true, runId, waitedMs: elapsed };
    }
    if (elapsed >= waitTimeoutMs) {
      ctx.log(`No automatic trigger detected for "${entry.pipelineName}" (${name}) within waitTimeoutMs=${waitTimeoutMs}, falling back`);
      return { name, pipelineName: entry.pipelineName, triggered: false, runId: '', waitedMs: elapsed };
    }
    await deps.sleepImpl(pollIntervalMs);
  }
}

export async function runAll(
  config: WaitForAdfPipelineTriggerConfig,
  ctx: StepContext,
  deps: AdfDeps = defaultDeps,
): Promise<StepResult> {
  if (!config.accessToken) throw new Error('config.accessToken is required');
  if (!config.pipelines || config.pipelines.length === 0) {
    throw new Error('config.pipelines must contain at least one pipeline');
  }
  config.pipelines.forEach((entry, i) => {
    if (!entry.pipelineName) throw new Error(`config.pipelines[${i}] is missing pipelineName`);
  });

  const results = await Promise.all(
    config.pipelines.map((entry, index) => waitForOnePipeline(entry, index, config, deps, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'wait-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const autoTriggeredCount = results.filter(r => r.triggered).length;
  const outputs: Record<string, string | number | boolean> = {
    totalPipelines: results.length,
    autoTriggeredCount,
    fallbackCount: results.length - autoTriggeredCount,
  };
  for (const r of results) {
    outputs[`${r.name}_triggered`] = r.triggered;
    outputs[`${r.name}_runId`] = r.runId;
    outputs[`${r.name}_waitedMs`] = r.waitedMs;
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<WaitForAdfPipelineTriggerConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 2: Write `steps/wait-for-adf-pipeline-trigger.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll, findAutoTriggeredRun } from './wait-for-adf-pipeline-trigger';
import type { FetchLike, AdfDeps } from './lib/adf-client';
import type { StepContext } from '../runner/types';

function fakeClock(overrides: Partial<AdfDeps> = {}): AdfDeps {
  let clock = 0;
  return {
    fetchImpl: overrides.fetchImpl ?? (async () => { throw new Error('fetchImpl not stubbed'); }),
    sleepImpl: overrides.sleepImpl ?? (async (ms: number) => { clock += ms; }),
    nowImpl: overrides.nowImpl ?? (() => clock),
  };
}

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

const TARGET = { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' };

test('findAutoTriggeredRun returns the first matching run id', async () => {
  let capturedBody = '';
  const fetchImpl: FetchLike = async (_url, init) => {
    capturedBody = init?.body ?? '';
    return { ok: true, status: 200, json: async () => ({ value: [{ runId: 'run-auto-1' }] }), text: async () => '' };
  };
  const runId = await findAutoTriggeredRun(
    TARGET,
    'CopyOrders',
    { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' },
    'token',
    fetchImpl,
  );
  assert.equal(runId, 'run-auto-1');
  const body = JSON.parse(capturedBody);
  assert.deepEqual(body.filters, [{ operand: 'PipelineName', operator: 'Equals', values: ['CopyOrders'] }]);
});

test('findAutoTriggeredRun returns undefined when no runs match', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' });
  const runId = await findAutoTriggeredRun(TARGET, 'CopyOrders', { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' }, 'token', fetchImpl);
  assert.equal(runId, undefined);
});

test('findAutoTriggeredRun throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
  await assert.rejects(
    () => findAutoTriggeredRun(TARGET, 'CopyOrders', { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' }, 'token', fetchImpl),
    /HTTP 500[\s\S]*boom/,
  );
});

test('runAll reports triggered:true as soon as a matching run is detected', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-adf-test-'));
  try {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ value: calls < 2 ? [] : [{ runId: 'run-auto-1' }] }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pollIntervalMs: 1000,
      waitTimeoutMs: 60000,
      pipelines: [{ name: 'copyOrders', pipelineName: 'CopyOrders' }],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(result.outputs?.totalPipelines, 1);
    assert.equal(result.outputs?.autoTriggeredCount, 1);
    assert.equal(result.outputs?.fallbackCount, 0);
    assert.equal(result.outputs?.copyOrders_triggered, true);
    assert.equal(result.outputs?.copyOrders_runId, 'run-auto-1');
    assert.equal(calls, 2);
    assert.ok(fs.existsSync(path.join(outDir, 'wait-summary.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll reports triggered:false and does not throw when the wait times out', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-adf-test-'));
  try {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' });
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pollIntervalMs: 1000,
      waitTimeoutMs: 2500,
      pipelines: [{ pipelineName: 'CopyOrders' }],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(result.outputs?.autoTriggeredCount, 0);
    assert.equal(result.outputs?.fallbackCount, 1);
    assert.equal(result.outputs?.p0_triggered, false);
    assert.equal(result.outputs?.p0_runId, '');
    assert.ok((result.outputs?.p0_waitedMs as number) >= 2500);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll handles a mixed batch: one pipeline auto-triggers, its sibling falls back', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-adf-test-'));
  try {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}');
      const pipelineName = body.filters[0].values[0];
      if (pipelineName === 'CopyOrders') {
        return { ok: true, status: 200, json: async () => ({ value: [{ runId: 'run-auto-1' }] }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pollIntervalMs: 1000,
      waitTimeoutMs: 1500,
      pipelines: [
        { name: 'copyOrders', pipelineName: 'CopyOrders' },
        { name: 'copyInvoices', pipelineName: 'CopyInvoices' },
      ],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(result.outputs?.autoTriggeredCount, 1);
    assert.equal(result.outputs?.fallbackCount, 1);
    assert.equal(result.outputs?.copyOrders_triggered, true);
    assert.equal(result.outputs?.copyOrders_runId, 'run-auto-1');
    assert.equal(result.outputs?.copyInvoices_triggered, false);
    assert.equal(result.outputs?.copyInvoices_runId, '');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll validates required config upfront', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-adf-test-'));
  try {
    await assert.rejects(
      () => runAll({ accessToken: '', pipelines: [] } as any, fakeCtx(outDir), fakeClock()),
      /accessToken is required/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', pipelines: [] }, fakeCtx(outDir), fakeClock()),
      /at least one pipeline/,
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

- [ ] **Step 3: Run the tests**

Run: `npx tsx --test steps/wait-for-adf-pipeline-trigger.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add steps/wait-for-adf-pipeline-trigger.ts steps/wait-for-adf-pipeline-trigger.test.ts
git commit -m "feat: add wait-for-adf-pipeline-trigger step (detects Control-M auto-triggers, never fails on timeout)"
```

---

### Task 5: Configs, YAML wiring, README, and removal of the old step

**Files:**
- Create: `configs/wait-for-adf-pipeline-trigger.json`, `configs/execute-adf-pipelines.json`, `configs/poll-adf-pipeline-runs.json`
- Modify: `configs/extract-adf-run-details.json`, `.pipelines/azure-pipelines.yml`, `README.md`
- Delete: `steps/trigger-adf-pipeline.ts`, `steps/trigger-adf-pipeline.test.ts`, `configs/trigger-adf-pipelines.json`

**Interfaces:**
- Consumes: `execute-adf-pipeline`'s `{name}_runId`/`{name}_status` outputs (Task 2), `poll-adf-pipeline-runs`'s `{name}_runId` output (Task 3), `wait-for-adf-pipeline-trigger`'s `{name}_runId` output (Task 4).

- [ ] **Step 1: Delete the superseded step and its files**

```bash
git rm steps/trigger-adf-pipeline.ts steps/trigger-adf-pipeline.test.ts configs/trigger-adf-pipelines.json
```

- [ ] **Step 2: Write `configs/wait-for-adf-pipeline-trigger.json`**

```json
{
  "accessToken": "{{env.ADF_ACCESS_TOKEN}}",
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "resourceGroup": "my-resource-group",
  "factoryName": "my-data-factory",
  "pollIntervalMs": 15000,
  "waitTimeoutMs": 600000,
  "pipelines": [
    { "name": "copyOrders", "pipelineName": "CopyOrdersPipeline" },
    { "name": "copyInvoices", "pipelineName": "CopyInvoicesPipeline" }
  ]
}
```

- [ ] **Step 3: Write `configs/execute-adf-pipelines.json`**

```json
{
  "accessToken": "{{env.ADF_ACCESS_TOKEN}}",
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "resourceGroup": "my-resource-group",
  "factoryName": "my-data-factory",
  "pipelines": [
    {
      "name": "copyOrders",
      "pipelineName": "CopyOrdersPipeline",
      "parameters": { "sourcePath": "{{steps.genUsersCsv.outputs.usersCsv_csvPath}}" },
      "existingRunId": "{{steps.waitForTrigger.outputs.copyOrders_runId}}"
    },
    {
      "name": "copyInvoices",
      "pipelineName": "CopyInvoicesPipeline",
      "parameters": { "runDate": "{{env.BUILD_SOURCEVERSIONDATE}}" },
      "existingRunId": "{{steps.waitForTrigger.outputs.copyInvoices_runId}}"
    }
  ]
}
```

- [ ] **Step 4: Write `configs/poll-adf-pipeline-runs.json`**

```json
{
  "accessToken": "{{env.ADF_ACCESS_TOKEN}}",
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "resourceGroup": "my-resource-group",
  "factoryName": "my-data-factory",
  "pollIntervalMs": 15000,
  "timeoutMs": 3600000,
  "runs": [
    { "name": "copyOrders", "runId": "{{steps.executeAdf.outputs.copyOrders_runId}}", "pipelineName": "CopyOrdersPipeline" },
    { "name": "copyInvoices", "runId": "{{steps.executeAdf.outputs.copyInvoices_runId}}", "pipelineName": "CopyInvoicesPipeline" }
  ]
}
```

- [ ] **Step 5: Update `configs/extract-adf-run-details.json`'s runId source**

Read the current file (`configs/extract-adf-run-details.json`) and replace its `runs` array so each `runId` is sourced from `pollAdf` instead of `triggerAdf`:

```json
{
  "accessToken": "{{env.ADF_ACCESS_TOKEN}}",
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "resourceGroup": "my-resource-group",
  "factoryName": "my-data-factory",
  "maxDepth": 5,
  "runs": [
    { "name": "copyOrders", "runId": "{{steps.pollAdf.outputs.copyOrders_runId}}" },
    { "name": "copyInvoices", "runId": "{{steps.pollAdf.outputs.copyInvoices_runId}}" }
  ]
}
```

- [ ] **Step 6: Rewire `.pipelines/azure-pipelines.yml`'s `Generate` stage**

In `.pipelines/azure-pipelines.yml`, find this block (currently around line 100):

```yaml
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

Replace it with:

```yaml
          # ---- Step 3a: wait to see if an external scheduler (e.g.
          # Control-M) already auto-triggered these pipelines -----------
          - script: >
              npx tsx runner/run-step.ts
              --step steps/wait-for-adf-pipeline-trigger.ts
              --config configs/wait-for-adf-pipeline-trigger.json
              --name waitForTrigger
            name: waitForTrigger
            displayName: 'Wait for automatic ADF pipeline trigger'
            env:
              ADF_ACCESS_TOKEN: $(adfAccessToken)

          # ---- Step 3b: trigger any pipeline that wasn't auto-triggered,
          # pass through the runId for any that was ----------------------
          - script: >
              npx tsx runner/run-step.ts
              --step steps/execute-adf-pipeline.ts
              --config configs/execute-adf-pipelines.json
              --name executeAdf
            name: executeAdf
            displayName: 'Trigger ADF pipelines (fallback for missed auto-triggers)'
            env:
              ADF_ACCESS_TOKEN: $(adfAccessToken)

          # ---- Step 3c: poll every ADF pipeline run to completion -------
          - script: >
              npx tsx runner/run-step.ts
              --step steps/poll-adf-pipeline-runs.ts
              --config configs/poll-adf-pipeline-runs.json
              --name pollAdf
            name: pollAdf
            displayName: 'Poll ADF pipeline runs to completion'
            env:
              ADF_ACCESS_TOKEN: $(adfAccessToken)
```

The `extractAdfDetails` step immediately below is unchanged (its config file was already updated in Step 5).

- [ ] **Step 7: Update `README.md`**

In the `## Layout` section, replace this line (currently line 19):

```
  trigger-adf-pipeline.ts     # trigger + poll ADF pipeline run(s) in parallel
```

with:

```
  wait-for-adf-pipeline-trigger.ts  # detect an already-fired automatic ADF trigger, or time out
  execute-adf-pipeline.ts     # trigger ADF pipeline run(s) in parallel (or pass through an existingRunId)
  poll-adf-pipeline-runs.ts   # poll ADF pipeline run(s) to a terminal status in parallel
```

In the same section's `lib/` block, add a line after `blob-client.ts`'s line:

```
    adf-client.ts             # shared ADF target resolution, URL builders, trigger + poll (used by the 3 steps above)
```

In the `configs/` block, replace:

```
  trigger-adf-pipelines.json
```

with:

```
  wait-for-adf-pipeline-trigger.json
  execute-adf-pipelines.json
  poll-adf-pipeline-runs.json
```

In `## The step contract (typed)` section, replace the paragraph:

```
The two exceptions to "every step is standalone": `steps/lib/blob-client.ts`
(shared by the three blob-storage steps) and `steps/lib/csv.ts` (shared by
`verify-row-count` and `validate-business-logic`) — both cases where three
or two steps needed identical, non-trivial logic and duplicating it bought
nothing.
```

with:

```
The three exceptions to "every step is standalone": `steps/lib/blob-client.ts`
(shared by the three blob-storage steps), `steps/lib/csv.ts` (shared by
`verify-row-count` and `validate-business-logic`), and `steps/lib/adf-client.ts`
(shared by `wait-for-adf-pipeline-trigger`, `execute-adf-pipeline`, and
`poll-adf-pipeline-runs`) — all cases where several steps needed identical,
non-trivial logic and duplicating it bought nothing.
```

In `## Running`, replace the block:

```
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

Extract ADF run details (needs the same `ADF_ACCESS_TOKEN` as
`trigger-adf-pipeline`; run IDs typically come from that step's outputs):
```

with:

```
Wait for an automatic ADF trigger, then execute (fallback) and poll to
completion (all need an ARM access token — see the `AzureCLI@2` task in
`.pipelines/azure-pipelines.yml`, or `az account get-access-token --resource
https://management.azure.com/` locally):

```bash
export ADF_ACCESS_TOKEN="$(az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv)"
npx tsx runner/run-step.ts \
  --step steps/wait-for-adf-pipeline-trigger.ts \
  --config configs/wait-for-adf-pipeline-trigger.json \
  --name waitForTrigger

npx tsx runner/run-step.ts \
  --step steps/execute-adf-pipeline.ts \
  --config configs/execute-adf-pipelines.json \
  --name executeAdf

npx tsx runner/run-step.ts \
  --step steps/poll-adf-pipeline-runs.ts \
  --config configs/poll-adf-pipeline-runs.json \
  --name pollAdf
```

Extract ADF run details (needs the same `ADF_ACCESS_TOKEN`; run IDs
typically come from `poll-adf-pipeline-runs`' outputs):
```

In `## How outputs flow`, point 2, replace:

```
2. **Pipeline output variables** — every output is emitted via
   `##vso[task.setvariable …;isOutput=true]`; read as
   `$(genUsersCsv.genUsersCsv.usersCsv_rowCount)` or via
   `stageDependencies`. `generate-synthetic-csv`, `gpg-encrypt-file`, and
   `trigger-adf-pipeline` all support multiple items per invocation, and
   all three flatten each item's outputs under a prefix — that item's
   configured `name` (or `f0`, `f1`, … / `p0`, `p1`, … by index if `name`
   is omitted), e.g. `$(triggerAdf.triggerAdf.copyOrders_status)`.
```

with:

```
2. **Pipeline output variables** — every output is emitted via
   `##vso[task.setvariable …;isOutput=true]`; read as
   `$(genUsersCsv.genUsersCsv.usersCsv_rowCount)` or via
   `stageDependencies`. `generate-synthetic-csv`, `gpg-encrypt-file`,
   `wait-for-adf-pipeline-trigger`, `execute-adf-pipeline`, and
   `poll-adf-pipeline-runs` all support multiple items per invocation, and
   all flatten each item's outputs under a prefix — that item's configured
   `name` (or `f0`, `f1`, … / `p0`, `p1`, … by index if `name` is omitted),
   e.g. `$(executeAdf.executeAdf.copyOrders_status)`.
```

- [ ] **Step 8: Run the full test suite and type-check**

Run: `npm test && npm run typecheck`
Expected: all tests pass (the suite total drops by the old `trigger-adf-pipeline.test.ts`'s tests and gains Tasks 1–4's new tests — verify the final count makes sense: 8 fewer old tests, `13 + 4 + 5 + 8 = 30` new ones), no typecheck errors.

- [ ] **Step 9: Commit**

```bash
git add configs/wait-for-adf-pipeline-trigger.json configs/execute-adf-pipelines.json \
  configs/poll-adf-pipeline-runs.json configs/extract-adf-run-details.json \
  .pipelines/azure-pipelines.yml README.md
git commit -m "feat: wire up wait/execute/poll ADF steps in the pipeline, remove trigger-adf-pipeline"
```

---

## Self-Review Notes

- Spec coverage: shared lib (Task 1), execute step (Task 2), poll step (Task 3), wait step (Task 4), YAML/config wiring + old-step removal + README (Task 5) — all design sections covered.
- No placeholders: every step contains complete, runnable code.
- Type consistency checked: `AdfDeps`/`FetchLike`/`AdfTarget` names and shapes are identical across Tasks 1–4; `resolveTarget`'s 3-arg signature is used consistently by all three callers; `execute-adf-pipeline`'s `{name}_runId` output name matches what Task 5's `poll-adf-pipeline-runs.json` and Task 3's `AdfRunToPoll.runId` expect; `wait-for-adf-pipeline-trigger`'s `{name}_runId` output name matches what Task 5's `execute-adf-pipelines.json` `existingRunId` expects.
