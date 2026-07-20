# Consolidate Run Results (Group D2) — Design

## Purpose

This is Group D2 of the run-reporting-and-Confluence feature set (Group D1,
`extract-adf-run-details`, is complete). Group D2 adds
`consolidate-run-results`, a step that folds a named set of prior steps'
outputs from the current pipeline run into one structured JSON — designed
to be trended over time (as a growing series of per-run JSON files,
uploaded elsewhere by an existing step like `upload-to-blob`) and to be
the direct input for Group E's Confluence publish step.

## Config

```ts
export interface ConsolidateRunResultsConfig {
  stepNames: string[];
  /** Arbitrary key-value metadata, interpolated via {{env.VAR}} like any other config field. */
  runMetadata?: Record<string, string>;
  /** Output artifact filename; defaults to "run-results.json". */
  fileName?: string;
}
```

`stepNames` is an explicit list (not dynamic discovery of everything in
the workspace) — a deliberate choice made earlier in this feature set's
design: if a step is renamed or removed, this config visibly needs
updating too, rather than the consolidated JSON's shape silently drifting.

## Mechanism

No file I/O or network calls beyond the final write. `StepContext.steps`
(from `runner/types.ts`) is already populated by the runner with every
prior step's full `StepOutputFile` — `ok`, `outputs`, `artifacts`,
`error` — read from `step-output/*/output.json` in the shared workspace.
Consolidation is a synchronous loop over `stepNames`, pulling each named
step's entry directly out of `ctx.steps`.

Cross-job/cross-stage consolidation requires no new mechanism: it works
exactly like the existing `Deliver` stage already does (`download:
current` pulling in the `Generate` stage's published `step-output/`
artifact) — `ctx.steps` is simply whatever's present in the workspace's
`step-output/` tree at the time this step runs.

### Missing vs. failed step

- A step name in `stepNames` **not present at all** in `ctx.steps` is a
  **hard error** — thrown immediately, naming every missing step name.
  This is a different situation than "ran and failed": it usually means a
  typo in `stepNames`, or a step that was skipped entirely by an earlier
  catastrophic failure — worth surfacing loudly rather than silently
  omitting from the report.
- A step **present** in `ctx.steps` with `ok: false` is included normally
  in the output as a failed entry — this does **not** fail
  `consolidate-run-results` itself. The whole point of this step is
  visibility into what happened, including failures, so a pipeline run
  with a failed step should still produce a report showing that failure,
  not silently skip reporting altogether.

All `outputs` from each named step are pulled wholesale (no per-field
selection config) — curation already happens at the `stepNames` level;
trimming individual fields was rejected as an extra config surface with
no strong benefit.

## Output shape

Written to an artifact file (`fileName`, default `run-results.json`):

```json
{
  "runMetadata": { "buildId": "...", "branch": "..." },
  "generatedAt": "<ISO timestamp, when this step ran>",
  "steps": [
    { "stepName": "genUsersCsv", "ok": true, "outputs": { "usersCsv_rowCount": 250 } },
    { "stepName": "extractAdfDetails", "ok": false, "outputs": {}, "error": "..." }
  ],
  "summary": { "totalSteps": 2, "succeededCount": 1, "failedCount": 1 }
}
```

`error` is included on a step's entry only when that step's `StepOutputFile.error`
is present (i.e., only for `ok: false` entries) — mirrors the `error?`
optionality already on `StepOutputFile` itself.

`StepResult.outputs` (the flat `Record<string, string|number|boolean>`
this repo's runner exposes as pipeline variables) carries only:
`consolidatedPath`, `totalSteps`, `succeededCount`, `failedCount`. No
per-entry `name`-prefixing convention (unlike the batch steps in Groups
A–D1) — this step produces exactly one consolidated file per invocation,
not a configurable list of independent items.

## `runMetadata`

An open, arbitrary key-value object, interpolated through the runner's
existing `{{env.VAR}}` mechanism exactly like any other config field —
e.g. `{ "buildId": "{{env.BUILD_BUILDID}}", "branch":
"{{env.BUILD_SOURCEBRANCH}}" }`. The step has no built-in knowledge of
Azure DevOps predefined variables; whatever the pipeline YAML chooses to
map into the step's env and reference here is copied into the output
as-is.

## YAML placement note

Since this step needs visibility into failures, it's typically wired with
`condition: always()` on its pipeline step so it still runs even when an
earlier step in the same job failed — otherwise Azure Pipelines would
skip it along with the rest of the job on a prior failure, defeating the
purpose.

## Out of scope

- No historical/trend computation in this step itself — it emits one
  clean data point for the current run; trending is computed later by
  whatever consumes the growing series of per-run JSON files (already
  decided earlier in this feature set's design).
- No per-field output selection — wholesale inclusion only (see above).
- No dynamic discovery of "everything that ran" — `stepNames` is explicit.
- No built-in Azure DevOps predefined-variable knowledge — `runMetadata`
  is a plain passthrough.
