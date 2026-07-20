# ADF Trigger/Poll/Wait Split — Design

## Purpose

`trigger-adf-pipeline.ts` currently does two things at once: trigger an ADF
pipeline run and poll it to completion. This splits those into two
single-purpose steps, and adds a third new step that supports testing
Control-M's automatic ADF triggers: wait to see whether Control-M already
fired a pipeline automatically, and only fall back to manually triggering it
if it didn't. This lets the same pipeline run either fully automated (via
Control-M) or with a manual fallback, without duplicating trigger/poll logic
per scenario.

## Architecture

```
steps/lib/adf-client.ts          (new — shared target-resolution, URL builders, triggerRun, pollUntilTerminal)
steps/execute-adf-pipeline.ts    (was trigger-adf-pipeline.ts, trimmed to trigger-only + pass-through)
steps/poll-adf-pipeline-runs.ts  (new — takes runIds, polls each to a terminal status)
steps/wait-for-adf-pipeline-trigger.ts  (new — detects an automatic trigger, or times out)
```

Pipeline flow for the Control-M testing scenario:

```
waitForTrigger → executeAdf (pass-through if already triggered, else triggers) → pollAdf → extractAdfDetails
```

`extract-adf-run-details.ts` is unchanged except for its config's runId
source (previously `{{steps.triggerAdf...}}`, now `{{steps.pollAdf...}}`).
It stays self-contained rather than joining `adf-client.ts` — same
documented reasoning as before: its overlap with the trigger/poll/wait
steps (URL prefix, auth header) is too small to justify touching shipped,
tested code.

## `steps/lib/adf-client.ts`

Extracted from the current `trigger-adf-pipeline.ts`, used by all three
trigger/poll/wait steps (large shared surface, unlike the extract step):

- `AdfTarget` type
- `resolveTarget(entry, config, label)` — per-entry/per-config-default
  resolution of `subscriptionId`/`resourceGroup`/`factoryName`, throwing a
  message that includes `label` (the pipeline name or run ID, depending on
  caller) when any are missing
- `FetchLike` interface
- `AdfDeps` (`fetchImpl`, `sleepImpl`, `nowImpl`) and `defaultDeps`
- `buildCreateRunUrl(target, pipelineName)`
- `buildPollUrl(target, runId)`
- `buildQueryPipelineRunsUrl(target)` (new — factory-scoped
  `POST .../factories/{factoryName}/queryPipelineRuns?api-version=2018-06-01`,
  distinct from `extract-adf-run-details`'s per-run `queryActivityRuns`)
- `isTerminalStatus(status)`
- `triggerRun(target, pipelineName, parameters, accessToken, fetchImpl)`
- `pollUntilTerminal(target, runId, accessToken, opts, deps)`

## `steps/execute-adf-pipeline.ts`

```ts
export interface AdfPipelineExecution {
  /** Friendly key used for this entry's output fields; defaults to "p{index}". */
  name?: string;
  pipelineName: string;
  parameters?: Record<string, unknown>;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /**
   * If set (non-empty), skip triggering and pass this runId through as
   * this entry's result — used when an upstream wait-for-adf-pipeline-trigger
   * step already detected an automatic trigger.
   */
  existingRunId?: string;
}

export interface ExecuteAdfPipelineConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  pipelines: AdfPipelineExecution[];
}
```

No polling — this step calls `createRun` (or passes an `existingRunId`
straight through) and returns immediately. Per-entry `status` is
`'Triggered' | 'PassedThrough' | 'FailedToTrigger'` — this is **not** the
pipeline's terminal run outcome anymore (that's `poll-adf-pipeline-runs`'
responsibility); it only reflects whether the trigger call (or pass-through)
itself succeeded. The step throws only if a `createRun` call fails.

Outputs, mirroring the existing per-entry convention:
- Per entry: `{name}_runId`, `{name}_status`, `{name}_pipelineName`
- Summary: `totalPipelines`, `succeededCount`, `failedCount`

Artifact: `execution-summary.json`.

## `steps/poll-adf-pipeline-runs.ts`

```ts
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
```

This is today's `pollUntilTerminal` loop, extracted verbatim in behavior:
polls each `runId` in parallel to a terminal status via `adf-client.ts`,
throws listing any run that didn't reach `Succeeded`. Output/artifact shape
matches today's step exactly, just renamed:
- Per entry: `{name}_runId`, `{name}_status`, `{name}_pipelineName` (when
  known — omitted if the caller didn't supply one), `{name}_durationMs`
- Summary: `totalPipelines`, `succeededCount`, `failedCount`

Artifact: `poll-summary.json`.

## `steps/wait-for-adf-pipeline-trigger.ts`

```ts
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
```

For each entry: records the step's own start time as the detection window's
floor (`lastUpdatedAfter` = floor minus a 60s pad, computed once, matching
`extract-adf-run-details`'s existing `deriveActivityWindow` padding
convention), then repeatedly calls `queryPipelineRuns` — body
`{ lastUpdatedAfter, lastUpdatedBefore: <current time + 60s pad, recomputed
each poll iteration>, filters: [{ operand: 'PipelineName', operator:
'Equals', values: [pipelineName] }] }` against
`buildQueryPipelineRunsUrl(target)` — every `pollIntervalMs`, taking the
first entry in the response's `value` array as a match, until either a
matching run appears or `waitTimeoutMs` elapses. Any matching run counts as
an automatic trigger — no filtering on `invokedBy` type.

**Never throws for "not triggered."** That is an expected, normal outcome
(Control-M didn't fire in time, so the pipeline falls back to a manual
trigger) — not an error. The step only throws on genuine failures: missing
required config, or a non-2xx from `queryPipelineRuns`.

Outputs:
- Per entry: `{name}_triggered` (boolean), `{name}_runId` (empty string if
  none was found), `{name}_waitedMs`
- Summary: `totalPipelines`, `autoTriggeredCount`, `fallbackCount`

Artifact: `wait-summary.json`.

## YAML wiring

```yaml
waitForTrigger (wait-for-adf-pipeline-trigger.ts)
  ↓ pipelines[0].existingRunId = "{{steps.waitForTrigger.outputs.p0_runId}}"
executeAdf (execute-adf-pipeline.ts)     — always runs; passes through if existingRunId is non-empty
  ↓ runs[0].runId = "{{steps.executeAdf.outputs.p0_runId}}"
pollAdf (poll-adf-pipeline-runs.ts)
  ↓ runs[0].runId = "{{steps.pollAdf.outputs.p0_runId}}"
extractAdfDetails (existing step; config's runId source updated from triggerAdf → pollAdf)
```

No YAML `condition:` is needed anywhere in this chain. Every step always
runs; the runner's `{{...}}` interpolation resolves a skipped detection to
an empty string, which is falsy in `execute-adf-pipeline`'s
`existingRunId` check, so the step naturally falls through to triggering
normally. This sidesteps the interpolation engine's lack of a
cross-step fallback/coalesce token — no runner changes needed.

All three steps continue to use the same `ADF_ACCESS_TOKEN` env mapping
already established for `trigger-adf-pipeline`/`extract-adf-run-details`.

## Testing

Each step gets unit tests following the existing `FetchLike`-injection
pattern (mirrors `trigger-adf-pipeline.test.ts` /
`extract-adf-run-details.test.ts`):

- `adf-client.test.ts` — pure-helper tests for URL building, target
  resolution, `isTerminalStatus`, `triggerRun`, `pollUntilTerminal`
  (these are largely today's `trigger-adf-pipeline.test.ts` cases, moved)
- `execute-adf-pipeline.test.ts` — trigger path, pass-through path (with
  `existingRunId` set), failed-trigger aggregation
- `poll-adf-pipeline-runs.test.ts` — polls-to-success, polls-to-failure,
  timeout, multi-run aggregation (today's polling-specific cases, moved)
- `wait-for-adf-pipeline-trigger.test.ts` — detected-before-timeout,
  timed-out-with-no-match, multi-pipeline mixed outcomes

## Out of scope

- No `invokedBy`-type filtering in the wait step — any matching run in the
  detection window counts as an automatic trigger, per the simpler of the
  two considered options.
- No retry of a failed `createRun`, poll, or `queryPipelineRuns` call —
  consistent with this repo's established "no retry of a one-shot REST
  call" precedent.
- No runner-level interpolation changes (no fallback/coalesce token) — the
  pass-through design in `execute-adf-pipeline` avoids needing one.
- `extract-adf-run-details.ts`'s own logic is not touched, only its config's
  runId source.
