# Extract ADF Run Details (Group D1) — Design

## Purpose

This is Group D1 of a larger, related batch of work: a run-reporting and
Confluence-publishing feature set. Group D1 adds a new step,
`extract-adf-run-details`, that takes a list of Azure Data Factory
pipeline run IDs and extracts full pipeline- and activity-level detail for
each — including recursively following any `ExecutePipeline` activity into
the child pipeline run it invoked. Its output is designed to be consumed
by Group D2 (`consolidate-run-results`, specced separately), which folds
this alongside other step outputs into one trending JSON, eventually
published to Confluence by Group E.

## Auth & config

Same auth pattern as the existing `trigger-adf-pipeline` step:
`accessToken` sourced from a bearer token the pipeline YAML fetches via
`AzureCLI@2` and maps into `{{env.ADF_ACCESS_TOKEN}}`. Top-level
`subscriptionId`/`resourceGroup`/`factoryName` act as shared defaults,
overridable per run entry — the same `resolveTarget`-style pattern
`trigger-adf-pipeline` already uses.

```ts
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
  maxDepth?: number;
  runs: AdfRunEntry[];
}
```

### Not sharing a lib with `trigger-adf-pipeline`

`trigger-adf-pipeline.ts` already has its own ADF REST URL-building and
bearer-token-header logic, written before this repo's "shared lib for
genuinely duplicated logic" pattern existed (`steps/lib/blob-client.ts`,
`steps/lib/csv.ts`). The overlap between it and this new step is small
(~10-15 lines: base URL prefix construction, `Authorization: Bearer`
header). This design deliberately does **not** retrofit a shared
`steps/lib/adf-client.ts` — extracting it would mean touching already-
shipped, tested, working code for a small duplication saving. This new
step is self-contained, the same way `trigger-adf-pipeline` was when it
was built.

## ADF REST mechanics

Two calls per pipeline run:

1. **Get Pipeline Run**: `GET
   https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.DataFactory/factories/{factory}/pipelineruns/{runId}?api-version=2018-06-01`
   → `runId`, `pipelineName`, `status`, `runStart`, `runEnd`,
   `durationInMs`.
2. **Query Activity Runs**: `POST .../pipelineruns/{runId}/queryActivityruns?api-version=2018-06-01`
   — this ADF API **requires** a `lastUpdatedAfter`/`lastUpdatedBefore`
   window in the request body (a real API constraint, not a design
   choice). Derived from the pipeline run's own `runStart`/`runEnd`,
   padded by one minute on each side (`runEnd` may be absent if the run
   is still in progress — falls back to "now + 1 minute"). Response is
   paginated via a `continuationToken`; the step loops until none
   remains.

For every activity with `activityType === 'ExecutePipeline'`, the
invoked child pipeline's run ID is read from that activity's
`output.pipelineRunId` field. The step recurses into that child run
(repeating both calls above) up to `maxDepth`. **Hitting the depth cap
stops recursion without failing the run** — it's a safety guard against a
pathological or accidentally-cyclic pipeline chain, not a business-rule
violation — the truncated pipeline run entry is marked `truncated: true`
in the output instead. Children discovered at the same recursion depth
are fetched concurrently (`Promise.all`), consistent with this repo's
"network I/O → concurrent" convention already established by
`trigger-adf-pipeline` and the blob storage steps.

## Concurrency & failure model

Matches `trigger-adf-pipeline`/the blob storage steps exactly: top-level
`runs` entries are processed concurrently (`Promise.all`), the step waits
for all before deciding pass/fail, and throws one aggregated error naming
every failed entry if any failed. A failure fetching one top-level run
(or a failure partway through its recursive extraction) does not block or
abort a sibling top-level run's extraction.

## Output shape

Two flat arrays — deliberately not a nested tree, per the earlier
decision — each entry tagged for joining rather than requiring tree
traversal downstream:

```ts
export interface PipelineRunDetail {
  runId: string;
  /** null for a top-level run; the parent pipeline run's runId otherwise. */
  parentRunId: string | null;
  pipelineName: string;
  status: string;
  runStart: string;
  runEnd?: string;
  durationMs?: number;
  /** true if maxDepth was reached and recursion stopped here. */
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
```

Since `StepResult.outputs` (per `runner/types.ts`) can only hold
`Record<string, string | number | boolean>` — no arrays — the full flat
detail is written to an artifact file, `adf-run-details.json`, containing
`{ pipelineRuns: PipelineRunDetail[], activities: ActivityDetail[] }`.
This is exactly the file Group D2's `consolidate-run-results` step is
expected to read. `outputs` itself carries only summary data, matching
every prior multi-item step's convention:

- Per top-level run entry: `{name}_status`, `{name}_durationMs`.
- Batch summary: `totalRuns` (top-level entries only, not counting
  recursively-discovered children), `succeededCount`, `failedCount`.

## Out of scope

- No retry of a failed ADF REST call (matches `trigger-adf-pipeline`'s
  existing precedent of not retrying `createRun` failures — a poll-style
  retry loop is a different concern than a one-shot detail fetch).
- No caching/deduplication if the same `runId` appears both as a
  top-level entry and as a recursively-discovered child of another
  top-level entry — it would simply be fetched and reported twice. Rare
  in practice (a user would have to deliberately pass a run ID that's
  also invoked as a sub-pipeline elsewhere in the same batch); not worth
  the bookkeeping.
- No shared `steps/lib/adf-client.ts` with `trigger-adf-pipeline.ts` —
  see "Not sharing a lib" above.
