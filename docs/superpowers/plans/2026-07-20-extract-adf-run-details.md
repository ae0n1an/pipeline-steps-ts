# Extract ADF Run Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new pipeline step, `extract-adf-run-details`, that takes a list of ADF pipeline run IDs and extracts full pipeline- and activity-level detail for each, recursively following any `ExecutePipeline` activity into its child pipeline run.

**Architecture:** A new, self-contained step file (no shared lib with `trigger-adf-pipeline.ts` — see the design spec's "Not sharing a lib" section) following the same shape as `trigger-adf-pipeline.ts`: `defineStep` wraps an exported `runAll(config, ctx, fetchImpl?)` that fans `Promise.all` out over top-level `runs` entries, each handled by a function that never rejects (catches its own errors into a result), waits for all, writes a JSON artifact with the full flat detail, and throws one aggregated error if any top-level entry failed. Recursion into `ExecutePipeline`-invoked child pipeline runs happens inside each top-level entry's own extraction, also fanned out concurrently at each depth level, capped by `maxDepth`.

**Tech Stack:** TypeScript, Node's global `fetch` (dependency-injected as `FetchLike` for testing, same pattern as `trigger-adf-pipeline.ts`), `tsx --test` / `node:test` / `node:assert/strict`.

## Global Constraints

- No new npm dependencies.
- `npm run typecheck` (tsc --noEmit) must pass after every task that touches `.ts` files.
- Auth: `accessToken` from `{{env.ADF_ACCESS_TOKEN}}` (already wired into the YAML by the earlier `trigger-adf-pipeline` work — no new pipeline-level auth wiring needed, just mapping the same env var into this new step's `env:` block).
- Top-level `runs` entries processed **concurrently**, wait-for-all, one aggregated error naming every failed entry — matches `trigger-adf-pipeline`/the blob storage steps' "network I/O → concurrent" convention.
- ADF's `queryActivityruns` REST call requires a `lastUpdatedAfter`/`lastUpdatedBefore` window in its request body — this is a real API constraint, derived from the pipeline run's own `runStart`/`runEnd`, padded by one minute each side.
- `ExecutePipeline` activities' child pipeline run ID comes from that activity's `output.pipelineRunId` field.
- Recursion depth is capped by `maxDepth` (default 5). Hitting the cap does **not** fail the run — the pipeline run's own detail and activities are still fetched and recorded; only further descent into any `ExecutePipeline` activities found at the cap is skipped, and only in that case is `truncated: true` set (a depth-cap run with no `ExecutePipeline` activities to follow is never marked truncated, since nothing was actually cut off).
- `StepResult.outputs` (per `runner/types.ts`) can only hold `Record<string, string | number | boolean>` — the full `pipelineRuns`/`activities` arrays go into an artifact file `adf-run-details.json`, never into `outputs` directly.
- Test command for this feature: `npx tsx --test steps/extract-adf-run-details.test.ts`.

---

## File Structure

- **Create:** `steps/extract-adf-run-details.ts` — the step module (types, pure helpers, network layer, recursive extraction, orchestration, default export).
- **Create:** `steps/extract-adf-run-details.test.ts` — unit tests, built up across Tasks 1–3.
- **Create:** `configs/extract-adf-run-details.json` — example config, chained onto the existing `triggerAdf` step's run-ID outputs.
- **Modify:** `.pipelines/azure-pipelines.yml` — add the new step invocation right after the existing `triggerAdf` step.
- **Modify:** `README.md` — Layout/configs listings, a new `## Running` example.

---

### Task 1: Config types and pure helpers

**Files:**
- Create: `steps/extract-adf-run-details.ts`
- Create: `steps/extract-adf-run-details.test.ts`

**Interfaces:**
- Produces: `AdfRunEntry { name?, runId, subscriptionId?, resourceGroup?, factoryName? }`; `ExtractAdfRunDetailsConfig { accessToken, subscriptionId?, resourceGroup?, factoryName?, maxDepth?, runs: AdfRunEntry[] }`; `AdfTarget { subscriptionId, resourceGroup, factoryName }`; `PipelineRunDetail { runId, parentRunId, pipelineName, status, runStart, runEnd?, durationMs?, truncated? }`; `ActivityDetail { pipelineRunId, activityId, activityName, activityType, status, activityRunStart, durationMs? }`; `resolveTarget(entry, config): AdfTarget` (throws if unresolvable); `buildPipelineRunUrl(target, runId): string`; `buildQueryActivityRunsUrl(target, runId): string`; `deriveActivityWindow(pipelineRun: { runStart: string; runEnd?: string }): { lastUpdatedAfter: string; lastUpdatedBefore: string }`.

- [ ] **Step 1: Write the failing tests**

Create `steps/extract-adf-run-details.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTarget,
  buildPipelineRunUrl,
  buildQueryActivityRunsUrl,
  deriveActivityWindow,
} from './extract-adf-run-details';

test('resolveTarget uses per-entry fields when present', () => {
  const target = resolveTarget(
    { runId: 'r1', subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    { accessToken: 't', runs: [] },
  );
  assert.deepEqual(target, { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
});

test('resolveTarget falls back to top-level config defaults', () => {
  const target = resolveTarget(
    { runId: 'r1' },
    { accessToken: 't', runs: [], subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
  );
  assert.deepEqual(target, { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
});

test('resolveTarget throws when a coordinate is missing everywhere', () => {
  assert.throws(
    () => resolveTarget({ runId: 'r1' }, { accessToken: 't', runs: [], subscriptionId: 'sub1' }),
    /missing subscriptionId\/resourceGroup\/factoryName/,
  );
});

test('buildPipelineRunUrl builds the ADF get-pipeline-run endpoint', () => {
  const url = buildPipelineRunUrl(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    'run-123',
  );
  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DataFactory/factories/f1/pipelineruns/run-123?api-version=2018-06-01',
  );
});

test('buildQueryActivityRunsUrl builds the ADF query-activity-runs endpoint', () => {
  const url = buildQueryActivityRunsUrl(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    'run-123',
  );
  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DataFactory/factories/f1/pipelineruns/run-123/queryActivityruns?api-version=2018-06-01',
  );
});

test('deriveActivityWindow pads runStart/runEnd by one minute each side', () => {
  const window = deriveActivityWindow({ runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:10:00.000Z' });
  assert.equal(new Date(window.lastUpdatedAfter).getTime(), new Date('2026-01-01T00:00:00.000Z').getTime() - 60_000);
  assert.equal(new Date(window.lastUpdatedBefore).getTime(), new Date('2026-01-01T00:10:00.000Z').getTime() + 60_000);
});

test('deriveActivityWindow falls back to "now" padded by a minute when runEnd is absent', () => {
  const before = Date.now();
  const window = deriveActivityWindow({ runStart: '2026-01-01T00:00:00.000Z' });
  const after = Date.now();
  const windowEndMs = new Date(window.lastUpdatedBefore).getTime();
  assert.ok(windowEndMs >= before + 60_000 - 1000 && windowEndMs <= after + 60_000 + 1000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/extract-adf-run-details.test.ts`
Expected: FAIL — `steps/extract-adf-run-details.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write the implementation**

Create `steps/extract-adf-run-details.ts`:

```ts
/**
 * Step: extract-adf-run-details (TypeScript)
 *
 * Extracts pipeline- and activity-level detail for a list of Azure Data
 * Factory pipeline run IDs, recursively following any ExecutePipeline
 * activity into the child pipeline run it invoked (up to maxDepth). Auth
 * is a bearer token fetched by the AzureCLI@2 task already used by
 * trigger-adf-pipeline (config.accessToken -> "{{env.ADF_ACCESS_TOKEN}}").
 *
 * Deliberately self-contained rather than sharing a lib with
 * trigger-adf-pipeline.ts — see the design spec's "Not sharing a lib"
 * section; the overlap (URL prefix, auth header) is small enough that
 * retrofitting already-shipped, tested code isn't worth it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';

const API_VERSION = '2018-06-01';

// ---------- Config types ----------------------------------------------------

export interface AdfRunEntry {
  /** Output key prefix for this run's results; defaults to "f{index}". */
  name?: string;
  runId: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export interface ExtractAdfRunDetailsConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** Safety cap on ExecutePipeline recursion depth; default 5. */
  maxDepth?: number | string;
  runs: AdfRunEntry[];
}

export interface AdfTarget {
  subscriptionId: string;
  resourceGroup: string;
  factoryName: string;
}

export interface PipelineRunDetail {
  runId: string;
  /** null for a top-level run; the parent pipeline run's runId otherwise. */
  parentRunId: string | null;
  pipelineName: string;
  status: string;
  runStart: string;
  runEnd?: string;
  durationMs?: number;
  /** true only if maxDepth was reached AND ExecutePipeline activities were found but not followed. */
  truncated?: boolean;
}

export interface ActivityDetail {
  /** Which pipeline run this activity belongs to. */
  pipelineRunId: string;
  activityId: string;
  activityName: string;
  activityType: string;
  status: string;
  activityRunStart: string;
  durationMs?: number;
}

// ---------- Target resolution ------------------------------------------------

export function resolveTarget(entry: AdfRunEntry, config: ExtractAdfRunDetailsConfig): AdfTarget {
  const subscriptionId = entry.subscriptionId ?? config.subscriptionId;
  const resourceGroup = entry.resourceGroup ?? config.resourceGroup;
  const factoryName = entry.factoryName ?? config.factoryName;
  if (!subscriptionId || !resourceGroup || !factoryName) {
    throw new Error(
      `Run "${entry.runId}" is missing subscriptionId/resourceGroup/factoryName ` +
      '(set them per-run or as top-level config defaults)',
    );
  }
  return { subscriptionId, resourceGroup, factoryName };
}

// ---------- URL building ------------------------------------------------------

export function buildPipelineRunUrl(target: AdfTarget, runId: string): string {
  return `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DataFactory/factories/${target.factoryName}/pipelineruns/${runId}?api-version=${API_VERSION}`;
}

export function buildQueryActivityRunsUrl(target: AdfTarget, runId: string): string {
  return `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DataFactory/factories/${target.factoryName}/pipelineruns/${runId}/queryActivityruns?api-version=${API_VERSION}`;
}

// ---------- Activity time window ----------------------------------------------

export function deriveActivityWindow(pipelineRun: { runStart: string; runEnd?: string }): {
  lastUpdatedAfter: string;
  lastUpdatedBefore: string;
} {
  const start = new Date(pipelineRun.runStart).getTime() - 60_000;
  const endBase = pipelineRun.runEnd ? new Date(pipelineRun.runEnd).getTime() : Date.now();
  const end = endBase + 60_000;
  return {
    lastUpdatedAfter: new Date(start).toISOString(),
    lastUpdatedBefore: new Date(end).toISOString(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/extract-adf-run-details.test.ts`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Unused imports `fs`, `path`, `StepContext`, `StepResult`, `defineStep` are fine at this point — Task 3 uses them, and this repo's tsconfig doesn't set `noUnusedLocals`.)

- [ ] **Step 6: Commit**

```bash
git add steps/extract-adf-run-details.ts steps/extract-adf-run-details.test.ts
git commit -m "feat: add config types and pure helpers for extract-adf-run-details step"
```

---

### Task 2: Network layer and recursive extraction

**Files:**
- Modify: `steps/extract-adf-run-details.ts`
- Modify: `steps/extract-adf-run-details.test.ts`

**Interfaces:**
- Consumes: `AdfTarget`, `buildPipelineRunUrl`, `buildQueryActivityRunsUrl`, `deriveActivityWindow`, `PipelineRunDetail`, `ActivityDetail` from Task 1.
- Produces: `FetchLike` type (`(url, init?) => Promise<{ ok, status, json(), text() }>`); `getPipelineRun(target, runId, accessToken, fetchImpl): Promise<{ runId: string; pipelineName: string; status: string; runStart: string; runEnd?: string; durationInMs?: number }>`; `queryActivityRuns(target, runId, accessToken, window, fetchImpl): Promise<Array<{ activityRunId: string; activityName: string; activityType: string; status: string; activityRunStart: string; durationInMs?: number; output?: unknown }>>`; `ExtractionResult { pipelineRuns: PipelineRunDetail[]; activities: ActivityDetail[] }`; `extractPipelineRunRecursive(target, runId, parentRunId, accessToken, fetchImpl, maxDepth, depth): Promise<ExtractionResult>`.

- [ ] **Step 1: Write the failing tests**

Append to `steps/extract-adf-run-details.test.ts` (new import line plus new tests):

```ts
import { getPipelineRun, queryActivityRuns, extractPipelineRunRecursive, type FetchLike } from './extract-adf-run-details';

const TARGET = { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' };

test('getPipelineRun returns parsed pipeline run data', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ runId: 'run-1', pipelineName: 'CopyOrders', status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z', durationInMs: 300000 }),
    text: async () => '',
  });
  const run = await getPipelineRun(TARGET, 'run-1', 'token', fetchImpl);
  assert.equal(run.pipelineName, 'CopyOrders');
  assert.equal(run.status, 'Succeeded');
});

test('getPipelineRun throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' });
  await assert.rejects(
    () => getPipelineRun(TARGET, 'run-1', 'token', fetchImpl),
    /HTTP 404[\s\S]*Not Found/,
  );
});

test('queryActivityRuns returns activities from a single page', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: '2026-01-01T00:01:00.000Z', durationInMs: 1000 }] }),
    text: async () => '',
  });
  const activities = await queryActivityRuns(TARGET, 'run-1', 'token', { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' }, fetchImpl);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].activityName, 'Copy1');
});

test('queryActivityRuns follows continuationToken across multiple pages', async () => {
  let call = 0;
  const bodies: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    call += 1;
    bodies.push(init?.body ?? '');
    if (call === 1) {
      return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't1' }], continuationToken: 'tok-2' }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: 'a2', activityName: 'Copy2', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't2' }] }), text: async () => '' };
  };
  const activities = await queryActivityRuns(TARGET, 'run-1', 'token', { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' }, fetchImpl);
  assert.deepEqual(activities.map(a => a.activityRunId), ['a1', 'a2']);
  assert.equal(call, 2);
  assert.equal(JSON.parse(bodies[0]).continuationToken, undefined);
  assert.equal(JSON.parse(bodies[1]).continuationToken, 'tok-2');
});

test('queryActivityRuns throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
  await assert.rejects(
    () => queryActivityRuns(TARGET, 'run-1', 'token', { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' }, fetchImpl),
    /HTTP 500[\s\S]*boom/,
  );
});

test('extractPipelineRunRecursive returns just the run and its activities when there are no ExecutePipeline activities', async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('queryActivityruns')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't1' }] }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ runId: 'run-1', pipelineName: 'CopyOrders', status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z' }), text: async () => '' };
  };
  const result = await extractPipelineRunRecursive(TARGET, 'run-1', null, 'token', fetchImpl, 5, 0);
  assert.equal(result.pipelineRuns.length, 1);
  assert.equal(result.pipelineRuns[0].truncated, undefined);
  assert.equal(result.activities.length, 1);
});

test('extractPipelineRunRecursive recurses into a child pipeline run invoked via ExecutePipeline', async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('queryActivityruns')) {
      if (url.includes('run-1/')) {
        return {
          ok: true, status: 200,
          json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'CallChild', activityType: 'ExecutePipeline', status: 'Succeeded', activityRunStart: 't1', output: { pipelineRunId: 'run-2' } }] }),
          text: async () => '',
        };
      }
      return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: 'a2', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't2' }] }), text: async () => '' };
    }
    if (url.includes('run-2')) {
      return { ok: true, status: 200, json: async () => ({ runId: 'run-2', pipelineName: 'ChildPipeline', status: 'Succeeded', runStart: '2026-01-01T00:01:00.000Z', runEnd: '2026-01-01T00:02:00.000Z' }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ runId: 'run-1', pipelineName: 'ParentPipeline', status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z' }), text: async () => '' };
  };
  const result = await extractPipelineRunRecursive(TARGET, 'run-1', null, 'token', fetchImpl, 5, 0);
  assert.equal(result.pipelineRuns.length, 2);
  const child = result.pipelineRuns.find(r => r.runId === 'run-2');
  assert.equal(child?.parentRunId, 'run-1');
  assert.equal(result.activities.length, 2);
});

test('extractPipelineRunRecursive stops descending at maxDepth and marks truncated, but still captures that run\'s own activities', async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('queryActivityruns')) {
      return {
        ok: true, status: 200,
        json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'CallChild', activityType: 'ExecutePipeline', status: 'Succeeded', activityRunStart: 't1', output: { pipelineRunId: 'run-2' } }] }),
        text: async () => '',
      };
    }
    return { ok: true, status: 200, json: async () => ({ runId: 'run-1', pipelineName: 'ParentPipeline', status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z' }), text: async () => '' };
  };
  // maxDepth 0 means depth 0 (this call) is already at the cap.
  const result = await extractPipelineRunRecursive(TARGET, 'run-1', null, 'token', fetchImpl, 0, 0);
  assert.equal(result.pipelineRuns.length, 1);
  assert.equal(result.pipelineRuns[0].truncated, true);
  assert.equal(result.activities.length, 1); // the ExecutePipeline activity itself is still captured
});

test('extractPipelineRunRecursive does not mark truncated when maxDepth is reached but there are no ExecutePipeline activities to follow', async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('queryActivityruns')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't1' }] }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ runId: 'run-1', pipelineName: 'LeafPipeline', status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z' }), text: async () => '' };
  };
  const result = await extractPipelineRunRecursive(TARGET, 'run-1', null, 'token', fetchImpl, 0, 0);
  assert.equal(result.pipelineRuns[0].truncated, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/extract-adf-run-details.test.ts`
Expected: FAIL — `getPipelineRun`/`queryActivityRuns`/`extractPipelineRunRecursive`/`FetchLike` are not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `steps/extract-adf-run-details.ts` (after the "Activity time window" section):

```ts
// ---------- Network layer (dependency-injected for testing) -------------------

export interface FetchLike {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;
}

interface RawPipelineRun {
  runId: string;
  pipelineName: string;
  status: string;
  runStart: string;
  runEnd?: string;
  durationInMs?: number;
}

interface RawActivityRun {
  activityRunId: string;
  activityName: string;
  activityType: string;
  status: string;
  activityRunStart: string;
  durationInMs?: number;
  output?: unknown;
}

export async function getPipelineRun(
  target: AdfTarget,
  runId: string,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<RawPipelineRun> {
  const res = await fetchImpl(buildPipelineRunUrl(target, runId), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Get pipeline run failed for "${runId}" (HTTP ${res.status}): ${body}`);
  }
  return res.json();
}

export async function queryActivityRuns(
  target: AdfTarget,
  runId: string,
  accessToken: string,
  window: { lastUpdatedAfter: string; lastUpdatedBefore: string },
  fetchImpl: FetchLike,
): Promise<RawActivityRun[]> {
  const results: RawActivityRun[] = [];
  let continuationToken: string | undefined;

  do {
    const res = await fetchImpl(buildQueryActivityRunsUrl(target, runId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...window, continuationToken }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Query activity runs failed for "${runId}" (HTTP ${res.status}): ${body}`);
    }
    const data = await res.json();
    results.push(...(data.value ?? []));
    continuationToken = data.continuationToken;
  } while (continuationToken);

  return results;
}

// ---------- Recursive extraction ------------------------------------------------

export interface ExtractionResult {
  pipelineRuns: PipelineRunDetail[];
  activities: ActivityDetail[];
}

export async function extractPipelineRunRecursive(
  target: AdfTarget,
  runId: string,
  parentRunId: string | null,
  accessToken: string,
  fetchImpl: FetchLike,
  maxDepth: number,
  depth: number,
): Promise<ExtractionResult> {
  const rawRun = await getPipelineRun(target, runId, accessToken, fetchImpl);

  const runDetail: PipelineRunDetail = {
    runId: rawRun.runId,
    parentRunId,
    pipelineName: rawRun.pipelineName,
    status: rawRun.status,
    runStart: rawRun.runStart,
    runEnd: rawRun.runEnd,
    durationMs: rawRun.durationInMs,
  };

  const window = deriveActivityWindow(rawRun);
  const rawActivities = await queryActivityRuns(target, runId, accessToken, window, fetchImpl);

  const activities: ActivityDetail[] = rawActivities.map(a => ({
    pipelineRunId: runId,
    activityId: a.activityRunId,
    activityName: a.activityName,
    activityType: a.activityType,
    status: a.status,
    activityRunStart: a.activityRunStart,
    durationMs: a.durationInMs,
  }));

  const childRunIds = rawActivities
    .filter(a => a.activityType === 'ExecutePipeline')
    .map(a => (a.output as { pipelineRunId?: string } | undefined)?.pipelineRunId)
    .filter((id): id is string => Boolean(id));

  if (childRunIds.length > 0 && depth >= maxDepth) {
    runDetail.truncated = true;
    return { pipelineRuns: [runDetail], activities };
  }

  const childResults = await Promise.all(
    childRunIds.map(childRunId =>
      extractPipelineRunRecursive(target, childRunId, runId, accessToken, fetchImpl, maxDepth, depth + 1),
    ),
  );

  const pipelineRuns = [runDetail, ...childResults.flatMap(r => r.pipelineRuns)];
  const allActivities = [...activities, ...childResults.flatMap(r => r.activities)];

  return { pipelineRuns, activities: allActivities };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/extract-adf-run-details.test.ts`
Expected: PASS — 16 tests total, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/extract-adf-run-details.ts steps/extract-adf-run-details.test.ts
git commit -m "feat: add ADF network layer and recursive pipeline-run extraction"
```

---

### Task 3: Orchestration and step export

**Files:**
- Modify: `steps/extract-adf-run-details.ts`
- Modify: `steps/extract-adf-run-details.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2 (`resolveTarget`, `extractPipelineRunRecursive`, `FetchLike`, `ExtractionResult`, `AdfRunEntry`, `ExtractAdfRunDetailsConfig`).
- Produces: `runAll(config: ExtractAdfRunDetailsConfig, ctx: StepContext, fetchImpl?: FetchLike): Promise<StepResult>`; the module's `default` export (a `StepModule<ExtractAdfRunDetailsConfig>` built with `defineStep`).

- [ ] **Step 1: Write the failing tests**

Append to `steps/extract-adf-run-details.test.ts`:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './extract-adf-run-details';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

function fakeFetchForRun(runId: string, pipelineName: string): FetchLike {
  return async (url) => {
    if (url.includes('queryActivityruns')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: `${runId}-a1`, activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't1' }] }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ runId, pipelineName, status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z', durationInMs: 300000 }), text: async () => '' };
  };
}

test('runAll extracts a single run end-to-end and writes adf-run-details.json', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adfdetails-test-'));
  try {
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      runs: [{ name: 'copyOrders', runId: 'run-1' }],
    };
    const result = await runAll(config, fakeCtx(outDir), fakeFetchForRun('run-1', 'CopyOrders'));
    assert.equal(result.outputs?.totalRuns, 1);
    assert.equal(result.outputs?.copyOrders_status, 'Succeeded');
    assert.equal(result.outputs?.copyOrders_durationMs, 300000);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'adf-run-details.json'), 'utf8'));
    assert.equal(summary.pipelineRuns.length, 1);
    assert.equal(summary.activities.length, 1);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll processes multiple runs concurrently; one failure does not block a sibling', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adfdetails-test-'));
  try {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('run-bad')) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' };
      }
      return fakeFetchForRun('run-good', 'GoodPipeline')(url);
    };
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      runs: [
        { name: 'good', runId: 'run-good' },
        { name: 'bad', runId: 'run-bad' },
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), fetchImpl),
      /1\/2 ADF run\(s\) failed to extract[\s\S]*bad[\s\S]*Failed/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws when config.accessToken is missing', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adfdetails-test-'));
  try {
    await assert.rejects(
      () => runAll({ accessToken: '', runs: [{ runId: 'r1' }] } as any, fakeCtx(outDir), fakeFetchForRun('r1', 'X')),
      /accessToken is required/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws when config.runs is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adfdetails-test-'));
  try {
    await assert.rejects(
      () => runAll({ accessToken: 't', runs: [] }, fakeCtx(outDir), fakeFetchForRun('r1', 'X')),
      /config\.runs must contain at least one run/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/extract-adf-run-details.test.ts`
Expected: FAIL — `runAll` is not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `steps/extract-adf-run-details.ts` (after the "Recursive extraction" section):

```ts
// ---------- Orchestration ----------------------------------------------------

interface EntryResult {
  name: string;
  runId: string;
  status: 'Succeeded' | 'Failed';
  durationMs?: number;
  message?: string;
  pipelineRuns: PipelineRunDetail[];
  activities: ActivityDetail[];
}

async function runOneEntry(
  entry: AdfRunEntry,
  index: number,
  config: ExtractAdfRunDetailsConfig,
  fetchImpl: FetchLike,
  ctx: StepContext,
): Promise<EntryResult> {
  const name = entry.name ?? `f${index}`;
  try {
    const target = resolveTarget(entry, config);
    const maxDepth = Number(config.maxDepth ?? 5);
    const result = await extractPipelineRunRecursive(target, entry.runId, null, config.accessToken, fetchImpl, maxDepth, 0);
    const topRun = result.pipelineRuns.find(r => r.runId === entry.runId);
    ctx.log(
      `Extracted run "${entry.runId}" (${name}): ${result.pipelineRuns.length} pipeline run(s), ${result.activities.length} activit(y/ies)`,
    );
    return {
      name,
      runId: entry.runId,
      status: 'Succeeded',
      durationMs: topRun?.durationMs,
      pipelineRuns: result.pipelineRuns,
      activities: result.activities,
    };
  } catch (err) {
    return {
      name,
      runId: entry.runId,
      status: 'Failed',
      message: (err as Error).message,
      pipelineRuns: [],
      activities: [],
    };
  }
}

export async function runAll(
  config: ExtractAdfRunDetailsConfig,
  ctx: StepContext,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<StepResult> {
  if (!config.accessToken) throw new Error('config.accessToken is required');
  if (!config.runs || config.runs.length === 0) {
    throw new Error('config.runs must contain at least one run');
  }

  const results = await Promise.all(
    config.runs.map((entry, index) => runOneEntry(entry, index, config, fetchImpl, ctx)),
  );

  const allPipelineRuns = results.flatMap(r => r.pipelineRuns);
  const allActivities = results.flatMap(r => r.activities);

  const summaryPath = path.join(ctx.outDir, 'adf-run-details.json');
  fs.writeFileSync(
    summaryPath,
    JSON.stringify({ pipelineRuns: allPipelineRuns, activities: allActivities }, null, 2),
  );

  const failed = results.filter(r => r.status !== 'Succeeded');
  const outputs: Record<string, string | number | boolean> = {
    totalRuns: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  for (const r of results) {
    outputs[`${r.name}_status`] = r.status;
    if (r.durationMs !== undefined) outputs[`${r.name}_durationMs`] = r.durationMs;
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.runId}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} ADF run(s) failed to extract:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<ExtractAdfRunDetailsConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/extract-adf-run-details.test.ts`
Expected: PASS — 20 tests total, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/extract-adf-run-details.ts steps/extract-adf-run-details.test.ts
git commit -m "feat: add runAll orchestration and default step export for extract-adf-run-details"
```

---

### Task 4: Example config, YAML wiring, and README

**Files:**
- Create: `configs/extract-adf-run-details.json`
- Modify: `.pipelines/azure-pipelines.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ExtractAdfRunDetailsConfig` from Task 1; the existing `trigger-adf-pipeline` step's per-run `{name}_runId` outputs (already in this repo, e.g. `triggerAdf.outputs.copyOrders_runId`).

- [ ] **Step 1: Create the example config**

Create `configs/extract-adf-run-details.json`:

```json
{
  "accessToken": "{{env.ADF_ACCESS_TOKEN}}",
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "resourceGroup": "my-resource-group",
  "factoryName": "my-data-factory",
  "maxDepth": 5,
  "runs": [
    { "name": "copyOrders", "runId": "{{steps.triggerAdf.outputs.copyOrders_runId}}" },
    { "name": "copyInvoices", "runId": "{{steps.triggerAdf.outputs.copyInvoices_runId}}" }
  ]
}
```

- [ ] **Step 2: Add the new step invocation to the YAML**

In `.pipelines/azure-pipelines.yml`, the `Generate` stage's `build_data` job currently has the `triggerAdf` step (script block ending around line 109 with its `env:` block) immediately followed by the `PublishPipelineArtifact@1` task (around line 111). Add a new step between them:

```yaml
          # ---- Step: extract detailed ADF run and activity reporting ---
          - script: >
              npx tsx runner/run-step.ts
              --step steps/extract-adf-run-details.ts
              --config configs/extract-adf-run-details.json
              --name extractAdfDetails
            name: extractAdfDetails
            displayName: 'Extract ADF run and activity details'
            env:
              ADF_ACCESS_TOKEN: $(adfAccessToken)
```

- [ ] **Step 3: Update README.md**

Update the `Layout` section's `steps/` listing to add:

```
  extract-adf-run-details.ts  # extract ADF pipeline + activity run detail, recursing into nested pipeline calls
```

Update the `configs/` listing to add:

```
  extract-adf-run-details.json
```

Add a new runnable example to the `## Running` section, after the existing `trigger-adf-pipeline` example:

```markdown
Extract ADF run details (needs the same `ADF_ACCESS_TOKEN` as
`trigger-adf-pipeline`; run IDs typically come from that step's outputs):

\`\`\`bash
npx tsx runner/run-step.ts \
  --step steps/extract-adf-run-details.ts \
  --config configs/extract-adf-run-details.json \
  --name extractAdfDetails
\`\`\`
```

- [ ] **Step 4: Verify the new config parses and the full suite still passes**

Run:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/extract-adf-run-details.json', 'utf8')))"
npm test
npm run typecheck
```
Expected: the `node -e` call prints the parsed object with no error; `npm test` shows all tests passing (20 new from this plan, plus the pre-existing suite — 83 tests as of this repo's last count — for 103 total); `npm run typecheck` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add configs/extract-adf-run-details.json .pipelines/azure-pipelines.yml README.md
git commit -m "docs: wire extract-adf-run-details step into pipeline YAML and README"
```
