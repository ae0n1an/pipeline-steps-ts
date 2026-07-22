# Confluence Gantt groupBy + Payload Report Sections — Design

## Purpose

Two related additions to the pipeline's reporting, both continuing the
`publish-to-confluence` sections work:

1. **`groupBy` on `layout: 'gantt'`** — today `groupBy` only works with
   `table`/`bullets`; a gantt section renders one chart for its whole
   array, with `gantt.sectionField` only splitting bars into Mermaid
   `section` blocks *within* that one chart. This adds true per-group
   charts — one independent Mermaid gantt diagram per distinct `groupBy`
   value — so a report can show "one timeline per ADF run" (or, if the
   underlying data already covers only one run, that single run's
   timeline), each still able to use `gantt.sectionField` internally to
   split a run's own child pipelines.
2. **New report sections for payload path/size/row-count** — the
   inbound (generated → encrypted → uploaded) and outbound (downloaded →
   decrypted → row-counted) payload's file details currently exist only
   as scattered per-step outputs, never surfaced in the Confluence
   report. This adds five new sections to the shipped example config,
   plus a config-only fix for a pre-existing gap: `verify-row-count` and
   `validate-json-schema` currently read the *encrypted* download
   (`verifyResult`'s output) instead of the decrypted file
   (`gpgDecryptResult`'s output, added in the prior `gpg-decrypt-file`
   feature but never wired downstream) — meaning today's row count and
   schema validation run against opaque encrypted bytes. This fixes that
   wiring as part of making "output payload row count" meaningful.

## Part 1: `groupBy` + `layout: 'gantt'`

### Code change

In `steps/publish-to-confluence.ts`, `renderSection`'s `groupBy` branch:

```ts
if (section.groupBy) {
  if (layout !== 'table' && layout !== 'bullets') {
    throw new Error(`section "${section.title}": groupBy is not supported on layout "${layout}"`);
  }
  ...
  const groupBody = layout === 'table' ? renderTableSection(section, items) : renderBulletsSection(section, items);
  ...
}
```

becomes:

```ts
if (section.groupBy) {
  if (layout !== 'table' && layout !== 'bullets' && layout !== 'gantt') {
    throw new Error(`section "${section.title}": groupBy is not supported on layout "${layout}"`);
  }
  ...
  const groupBody = layout === 'table' ? renderTableSection(section, items)
    : layout === 'bullets' ? renderBulletsSection(section, items)
    : renderGanttSection({ ...section, title: `${section.title} — ${key}` }, items);
  ...
}
```

`renderGanttSection` itself is unchanged — it already reads `section.title`
for the Mermaid `title` line and `section.gantt` for the field config; a
shallow-copied section with an amended `title` is enough to make each
group's chart self-identify, without threading a new parameter through
the function. The `<h2>{section.title}</h2>` wrapping the whole group of
charts, and the `<h3>{key}</h3>` per group, are unaffected — this only
changes what appears *inside* each group's own Mermaid `title` line.

### Behavior

- `groupBy` + `gantt` now renders one `<h3>{key}</h3>` + one independent
  Mermaid code-block per distinct group value, in order of first
  appearance — structurally identical to how `groupBy` already renders
  one `<h3>{key}</h3>` + one table/bullets block per group.
- Each group's chart's Mermaid `title` line is
  `{section.title} — {key}` (colon-stripped like every other Mermaid text
  field, via the existing `sanitizeMermaidText` call already applied to
  `section.title` inside `renderGanttSection`).
- `gantt.sectionField` (existing, unchanged) still works *inside* each
  group's chart — e.g. `groupBy: "topLevelRunId"` for one chart per
  top-level run, `gantt.sectionField: "pipelineRunId"` inside each of
  those charts to split that run's own child pipelines into Mermaid
  `section` blocks. If the data passed to the section already covers a
  single run (e.g. because an upstream step/config only ever tracks one
  run), `groupBy` naturally produces exactly one chart — "a single run
  and its children" is just the one-group case of this same mechanism,
  not a separate code path.
- No new error cases: `groupBy` + `gantt` on non-array data still hits the
  existing `groupBy requires array data` check (unchanged, runs before
  the layout dispatch); a gantt-specific validation error (missing
  `gantt.taskField`/`startField`, or an item with no resolvable end time)
  still fires per-group exactly as it would for the whole array today,
  since each group is rendered through the same `renderGanttSection`.

### Example

```json
{
  "title": "ADF Activity Timeline by Run",
  "dataFrom": "extractAdfDetails",
  "source": "data",
  "arrayPath": "activities",
  "layout": "gantt",
  "groupBy": "topLevelRunId",
  "gantt": {
    "taskField": "activityName",
    "startField": "activityRunStart",
    "durationField": "durationMs",
    "sectionField": "pipelineRunId"
  }
}
```

## Part 2: Payload report sections + wiring fix

### 2a. Wiring fix (config-only, no step code changes)

`configs/verify-row-count.json` and `configs/validate-json-schema.json`
both currently set:

```json
"filePath": "{{steps.verifyResult.outputs.result_localPath}}"
```

Change both to:

```json
"filePath": "{{steps.gpgDecryptResult.outputs.result_decryptedPath}}"
```

`gpgDecryptResult`'s file entry is named `"result"` in
`configs/gpg-decrypt-result.json`, so its decrypted-path output key is
`result_decryptedPath` (confirmed against `gpg-decrypt-file.ts`'s actual
output-key convention, `${name}_decryptedPath`). This makes row-count and
schema validation run against the real decrypted JSON, not the encrypted
`.gpg` bytes — a correctness fix independent of reporting, but required
for the new "Output Row Count" section (2c below) to show a meaningful
number.

### 2b. `configs/consolidate-run-results.json`

Add two entries to `stepNames` (no `embedArtifacts` change — see the
cross-stage path reasoning below):

```json
"stepNames": [
  "genUsersCsv",
  "gpgEncryptCsv",
  "uploadPayload",
  "waitForTrigger",
  "executeAdf",
  "pollAdf",
  "extractAdfDetails",
  "verifyResult",
  "gpgDecryptResult",
  "verifyRowCount",
  "validateSchema",
  "validateBusinessLogic"
]
```

**Why no `embedArtifacts` for `uploadPayload`:** `upload-to-blob.ts`
writes an array-shaped `upload-summary.json`, which looked like a natural
fit for `layout: 'table'` via `embedArtifacts`/`source: 'data'`. But
`embedArtifacts` resolves the artifact by the **absolute path** recorded
in that step's own `output.json` at the time it ran
(`steps/consolidate-run-results.ts`'s `loadEmbeddedArtifact`, matching by
basename against `stepOutput.artifacts` then `fs.readFileSync`-ing that
exact path). `uploadPayload` runs in the **Generate** stage;
`consolidateResults` runs in **Deliver** — a different stage, which in
Azure Pipelines may run on a different agent/workspace entirely. The
Generate-stage step's absolute path baked into its `output.json` is not
guaranteed to exist on the Deliver-stage agent even after
`download: current, artifact: step-output` re-materializes the
`step-output/` tree there (the flat `outputs` — plain strings/numbers —
survive this fine since they need no file re-read; only `embedArtifacts`'
`fs.readFileSync` of a *recorded* absolute path is at risk). Since every
step in this pipeline only ever processes one file per config today, the
flat `outputs` already contain everything needed (blob path, size,
status) — so every new section below uses `source: 'outputs'` (the
default) and `layout: 'keyvalue'`, sidestepping the cross-stage path risk
entirely. If a future config batches multiple files through
`upload-to-blob`, revisit this with either same-stage embedding or a
path-portable embed mechanism — out of scope here.

### 2c. Five new sections in `configs/publish-to-confluence.json`

Field names below are verified against the real, current contents of
`configs/generate-users-csv.json` (file entry `"usersCsv"`),
`configs/gpg-encrypt-users-csv.json` (`"usersCsvGpg"`),
`configs/upload-to-blob.json` (`"usersCsvGpg"`),
`configs/gpg-decrypt-result.json` (`"result"`), and
`configs/verify-row-count.json` (`"outboundResult"`) — not assumed from
naming convention alone.

```json
{
  "title": "Generated CSV",
  "dataFrom": "genUsersCsv",
  "layout": "keyvalue",
  "fields": [
    { "label": "Path", "field": "usersCsv_csvPath" },
    { "label": "Rows", "field": "usersCsv_rowCount" },
    { "label": "Size", "field": "usersCsv_sizeBytes", "format": "bytes" }
  ]
},
{
  "title": "Encrypted Payload",
  "dataFrom": "gpgEncryptCsv",
  "layout": "keyvalue",
  "fields": [
    { "label": "Path", "field": "usersCsvGpg_encryptedPath" },
    { "label": "Size", "field": "usersCsvGpg_sizeBytes", "format": "bytes" }
  ]
},
{
  "title": "Uploaded Blob",
  "dataFrom": "uploadPayload",
  "layout": "keyvalue",
  "fields": [
    { "label": "Blob Path", "field": "usersCsvGpg_blobPath" },
    { "label": "Size", "field": "usersCsvGpg_sizeBytes", "format": "bytes" },
    { "label": "Status", "field": "usersCsvGpg_status", "format": "status" }
  ]
},
{
  "title": "Decrypted Output",
  "dataFrom": "gpgDecryptResult",
  "layout": "keyvalue",
  "fields": [
    { "label": "Path", "field": "result_decryptedPath" },
    { "label": "Size", "field": "result_sizeBytes", "format": "bytes" }
  ]
},
{
  "title": "Output Row Count",
  "dataFrom": "verifyRowCount",
  "layout": "keyvalue",
  "fields": [
    { "label": "Rows", "field": "outboundResult_rowCount" }
  ]
}
```

Each is a plain `keyvalue` section against an existing step's flat
`outputs` — no new `ReportSection`/`ReportField` capability is required
for this part; it's purely new config content, using formatters
(`bytes`, `status`) that already exist. These are placed in the shipped
example config after the existing "ADF Pipeline Runs"/"ADF
Activities"/"ADF Activity Timeline"/"Business Logic Validation" sections
(inbound-payload sections first, in pipeline order: Generated CSV →
Encrypted Payload → Uploaded Blob, then outbound: Decrypted Output →
Output Row Count).

## Testing

**Part 1 (`groupBy` + `gantt`):** extends
`steps/publish-to-confluence.test.ts` with: a test asserting one
independent Mermaid code-block per group (order of first appearance,
same `indexOf`-position-comparison style already used for the existing
`gantt`/`groupBy` tests), each containing its own `title ... — {key}`
line; a test confirming `gantt.sectionField` still splits bars within one
group's chart; and updating the existing "groupBy + gantt throws" test
(`groupBy is not supported on layout "gantt"`) to instead assert `gantt`
now *works* under `groupBy` — replaced with a genuinely unsupported
combination for the still-must-throw case (e.g. `groupBy` +
`layout: 'keyvalue'`, since `keyvalue` is not array-shaped and was never
a groupBy target).

**Part 2:** no `publish-to-confluence.ts`/`.test.ts` changes (pure config
content) — verified instead by re-running the full test suite (proving
nothing broke) and by the same manual field-name cross-checking done
here (already performed against the real step/config files, not
re-derived at implementation time).

## Out of scope

- No change to `upload-to-blob.ts`, `verify-row-count.ts`, or any other
  step's code — this is entirely config + one `publish-to-confluence.ts`
  code change (Part 1).
- No general solution for embedding array artifacts across stage
  boundaries — flagged above as a real gap, deferred until a config
  actually needs to batch multiple files through a Generate-stage step
  and report on them as a table.
- No change to `gantt`'s existing `sectionField` behavior, `resolveGanttEnd`,
  or `sanitizeMermaidText` — Part 1 only touches `renderSection`'s
  dispatch.
