# Trigger ADF Pipeline Step — Design

## Purpose

Add a new pipeline step, `steps/trigger-adf-pipeline.ts`, that triggers one or
more Azure Data Factory (ADF) pipeline runs (with caller-supplied parameters),
polls each to completion, and fails the step if any run doesn't succeed. It
follows the existing `defineStep<TConfig>()` contract used by
`generate-synthetic-csv.ts` and `gpg-encrypt-file.ts`.

## Auth

A new `AzureCLI@2` task in `azure-pipelines.yml` runs before the step and
fetches a management-plane access token:

```bash
az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv
```

The token is exported as a pipeline variable and mapped into the step's `env`
as `ADF_ACCESS_TOKEN`, mirroring how `GPG_PUBLIC_KEY` is mapped in for the
existing `gpg-encrypt-file` step. The step's config references it via
`"accessToken": "{{env.ADF_ACCESS_TOKEN}}"`.

No new npm dependency is introduced — the step calls the ADF REST API
(`https://management.azure.com/...`, `api-version=2018-06-01`) directly using
Node's global `fetch`.

## Config shape

```ts
export interface AdfPipelineRun {
  /** Friendly key used for this run's output fields; defaults to "p{index}". */
  name?: string;
  pipelineName: string;
  parameters?: Record<string, unknown>;
  /** Per-run overrides; fall back to the top-level defaults below. */
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export interface TriggerAdfPipelineConfig {
  accessToken: string;
  /** Shared defaults, overridable per-run for cross-factory scenarios. */
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** Poll interval while waiting for a run to finish. Default 15000. */
  pollIntervalMs?: number;
  /** Max time to wait for a single run before treating it as failed. Default 3600000 (1h). */
  timeoutMs?: number;
  pipelines: AdfPipelineRun[];
}
```

Each run resolves its own `subscriptionId` / `resourceGroup` / `factoryName`
from its own fields, falling back to the top-level config fields. This covers
the common case (one factory, many pipelines) without extra nesting, while
still allowing a rare cross-factory batch.

## Execution flow

1. **Trigger**: for each entry in `config.pipelines`, issue
   `POST https://management.azure.com/subscriptions/{subscriptionId}/resourceGroups/{resourceGroup}/providers/Microsoft.DataFactory/factories/{factoryName}/pipelines/{pipelineName}/createRun?api-version=2018-06-01`
   with `parameters` as the JSON body, using `Authorization: Bearer {accessToken}`.
   The response body's `runId` is captured.
2. **Poll**: for each triggered run, issue
   `GET https://management.azure.com/subscriptions/{subscriptionId}/resourceGroups/{resourceGroup}/providers/Microsoft.DataFactory/factories/{factoryName}/pipelineruns/{runId}?api-version=2018-06-01`
   every `pollIntervalMs`, until `status` reaches a terminal value
   (`Succeeded`, `Failed`, `Cancelled`) or `timeoutMs` elapses. A timeout is
   recorded as a failed result for that run (status `TimedOut`), without
   cancelling the underlying ADF run.
3. **Concurrency**: all runs are triggered and polled concurrently. Each
   run's poll loop is independent — a failure or timeout on one run never
   aborts or blocks another's polling. Implemented as one `async` poll
   function per run, awaited together (all settle before the step decides
   pass/fail).
4. **Pass/fail**: once every run has reached a terminal state, if any run's
   final status is not `Succeeded`, the step throws one aggregated `Error`
   whose message lists each non-succeeded run (`name`, `pipelineName`,
   `runId`, final `status`). The runner's existing catch-all in
   `run-step.ts` handles turning this into an ADO `##vso[task.logissue
   type=error]` + `task.complete result=Failed`, and writes `output.json`
   with `ok:false`.

## Outputs & artifacts

`StepResult.outputs` is flat (`Record<string, string | number | boolean>`),
so per-run fields are prefixed by each run's `name` (or `p{index}` if no name
was given):

- `{name}_runId`
- `{name}_status`
- `{name}_pipelineName`
- `{name}_durationMs`

Plus batch-level summary fields:

- `totalPipelines`
- `succeededCount`
- `failedCount`

A `run-summary.json` (one object per run, with the same fields plus any
error detail) is written to `ctx.outDir` and returned in `artifacts`, so the
full detail is available even though `outputs` is flattened.

## Error handling

- Missing `accessToken`, empty `pipelines` array, or a run missing
  `pipelineName` → thrown synchronously before any HTTP calls, same
  fail-fast style as `gpg-encrypt-file.ts`'s upfront validation.
- Non-2xx from `createRun` → that run is recorded as failed immediately
  (no polling attempted) with the HTTP status/body in its error detail.
- Non-2xx from a poll `GET` → treated as a transient error; retried up to
  the same `timeoutMs` budget rather than instant-failing the run, since
  management-plane throttling (429) is expected under concurrent polling.

## YAML wiring

`.pipelines/azure-pipelines.yml` gains:

1. An `AzureCLI@2` task (before the new step's script task) that fetches the
   token and sets it as a pipeline variable.
2. A new step invocation:
   ```yaml
   - script: >
       npx tsx runner/run-step.ts
       --step steps/trigger-adf-pipeline.ts
       --config configs/trigger-adf-pipelines.json
       --name triggerAdf
     name: triggerAdf
     displayName: 'Trigger ADF pipelines'
     env:
       ADF_ACCESS_TOKEN: $(adf-access-token)
   ```
3. New example config `configs/trigger-adf-pipelines.json` with two example
   pipeline runs to demonstrate the parallel case.

## Out of scope

- No `@azure/identity` / ADF SDK route — the AzureCLI@2 token approach was
  chosen explicitly over the SDK-in-step alternative.
- No pipeline cancellation on timeout or on a sibling's failure — runs that
  time out are left running in ADF; the step just stops waiting on them.
- No retry of a failed `createRun` call — a failed trigger is a failed run
  for that entry.
