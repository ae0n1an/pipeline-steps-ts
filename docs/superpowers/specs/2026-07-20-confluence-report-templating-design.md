# Confluence Report Templating — Design

## Purpose

Today's `publish-to-confluence` renders exactly one fixed layout: a "Run
Summary" table plus a generic "Step Results" table where every step's flat
`outputs` are jammed into one cell as `key: value` lines. Two problems:

1. Rich nested data — e.g. `extract-adf-run-details`'s per-pipeline-run and
   per-activity detail (start times, durations, IDs, statuses) — never
   reaches the report at all. It lives only in that step's own artifact
   file (`adf-run-details.json`), invisible to `consolidate-run-results`,
   which today only captures each step's flat `outputs`.
2. There's no way to customize layout — every step renders identically,
   with no tables-with-columns, no bullet lists, no per-report visual
   control.

This closes both gaps: `consolidate-run-results` gains the ability to embed
a step's full JSON artifact (not just its flat outputs), and
`publish-to-confluence` gains a declarative `sections` config that controls
exactly how each part of the report renders.

## `consolidate-run-results` changes

```ts
export interface ConsolidateRunResultsConfig {
  stepNames: string[];
  /**
   * Step name -> artifact filename to also embed as parsed JSON under
   * that step's `data` field, alongside its existing flat `outputs`.
   * The filename is matched by basename against that step's own
   * StepOutputFile.artifacts list (the paths the step itself reported
   * writing).
   */
  embedArtifacts?: Record<string, string>;
  runMetadata?: Record<string, string>;
  fileName?: string;
}

export interface ConsolidatedStepEntry {
  stepName: string;
  ok: boolean;
  outputs: Record<string, string | number | boolean>;
  /** Parsed content of the embedded artifact, when embedArtifacts names this step. */
  data?: unknown;
  error?: string;
}
```

### Validation (fails fast, matching this step's existing style)

- `embedArtifacts` naming a step not present in `stepNames` throws
  immediately, before any file I/O: `embedArtifacts references step(s) not
  in stepNames: <names>`.
- For each `embedArtifacts` entry, if that step's `artifacts` array (from
  its `output.json`) contains no path whose basename equals the configured
  filename, throws: `Step "<name>": no artifact named "<file>" found (has:
  <basenames>)`.
- If the matched file can't be read or isn't valid JSON, throws with the
  file path and the underlying error message.
- A step present in `stepNames` but *not* named in `embedArtifacts` behaves
  exactly as today — `data` is simply omitted from its entry.

### Mechanism

For each `stepNames` entry with a matching `embedArtifacts` key: find the
artifact path via `steps[name].artifacts.find(p =>
path.basename(p) === embedArtifacts[name])`, `fs.readFileSync` +
`JSON.parse` it, assign to `entry.data`. This is the only new file I/O this
step performs — everything else (the `outputs` pass-through, missing-step
detection, summary counts) is unchanged.

## `publish-to-confluence` changes

### Config

```ts
export interface PublishToConfluenceConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey: string;
  pageTitle: string;
  parentPageId?: string;
  resultsPath: string;
  /** Optional custom report layout. Omitted = today's exact behavior (Run Summary + generic Step Results table). */
  sections?: ReportSection[];
}

export interface ReportSection {
  title: string;
  /** Step name, matching ConsolidatedStepEntry.stepName in the results JSON. */
  dataFrom: string;
  /** Which part of that step's entry to read. Default 'outputs'. */
  source?: 'outputs' | 'data';
  /** Dot-path within the selected source to the array or object to render. Omit to use the whole source value as-is. */
  arrayPath?: string;
  /** Default 'keyvalue'. */
  layout?: 'table' | 'bullets' | 'keyvalue';
  /** Dot-paths (per item) to extract, with display labels. Omit to use every own-enumerable key of each item, in insertion order. */
  fields?: { label: string; field: string }[];
}
```

### Rendering rules

- **`table`**: the resolved data (via `arrayPath`, or the whole source if
  omitted) must be an array; one `<tr>` per item, one `<td>` per `fields`
  entry (or per own key, if `fields` omitted). A non-array resolved value
  throws (`section "<title>": table layout requires array data at
  "<arrayPath>"`).
- **`bullets`**: if the resolved data is an array, each item renders as its
  own `<p><strong>` sub-heading (using the item's index — `Item 1`, `Item
  2`, … — since no `itemTitleField` concept is introduced; keeping this
  scoped) followed by a `<ul>` of that item's `fields` as `label: value`
  lines. If the resolved data is a plain object, it renders as one flat
  `<ul>` of `label: value` lines.
- **`keyvalue`**: same two-column `<table>` style as today's "Run Summary"
  block — one row per field (`fields`, or every own key). Works on a single
  object; if the resolved data is an array, throws (`section "<title>":
  keyvalue layout requires object data, got an array — did you mean
  layout: "bullets"?`).
- **Cell-level nested bullets (automatic, no config)**: in `table` layout,
  if a resolved field value is itself an array or a plain object (not a
  primitive), it renders as a nested `<ul>` inside that `<td>` instead of
  being stringified — this both implements "bullets inside table cells"
  and prevents the current code's implicit `String(value)` from ever
  producing `[object Object]`. This nested rendering is the same object/array
  bullet logic as the `bullets` layout itself, applied recursively: a
  nested object becomes a flat `<ul>` of `label: value` lines (using its
  own keys, since there's no `fields` list at this depth); a nested array
  becomes one `<li>` per item, each recursively rendered the same way.
- Every leaf value (primitive) is passed through the existing
  `escapeXhtml` before insertion, exactly as today.
- Dot-path resolution (`arrayPath`, each `fields[].field`) is a small new
  helper, `resolveFieldPath(obj, path)`, splitting on `.` — same shape as
  the runner's own `{{steps.a.b}}` interpolation, but a fresh, local
  implementation (steps don't share code with the runner). A path that
  resolves to `undefined` renders as an empty cell/line, not a thrown
  error — a genuinely absent field is common (e.g. `runEnd` on a
  still-running pipeline) and shouldn't fail the whole report.
- A `dataFrom` naming a step absent from the results JSON's `steps` array,
  or a `source: 'data'` request against a step with no `data` field, throws
  immediately, before any network call — same "validate everything up
  front" convention as the rest of this step.

### What stays exactly the same

- The top "Run Summary" table (build metadata + `generatedAt` +
  succeeded/failed/total counts) is unconditional — rendered before any
  section, `sections` config or not.
- When `config.sections` is omitted or empty, the rest of the page renders
  exactly as `renderConfluenceStorageFormat` does today (the generic
  "Step Results" table, one row per step, flattened `outputs`). No existing
  config or test changes behavior.
- `findExistingPage`/`createPage`/`updatePage`, the artifact-before-network
  write order, and the create-vs-update flow are all untouched.

### Example — ADF pipeline-run and activity tables

```json
{
  "sections": [
    {
      "title": "ADF Pipeline Runs",
      "dataFrom": "extractAdfDetails",
      "source": "data",
      "arrayPath": "pipelineRuns",
      "layout": "table",
      "fields": [
        { "label": "Pipeline", "field": "pipelineName" },
        { "label": "Run ID", "field": "runId" },
        { "label": "Status", "field": "status" },
        { "label": "Start", "field": "runStart" },
        { "label": "Duration (ms)", "field": "durationMs" }
      ]
    },
    {
      "title": "ADF Activities",
      "dataFrom": "extractAdfDetails",
      "source": "data",
      "arrayPath": "activities",
      "layout": "table",
      "fields": [
        { "label": "Activity", "field": "activityName" },
        { "label": "Activity ID", "field": "activityId" },
        { "label": "Status", "field": "status" },
        { "label": "Start", "field": "activityRunStart" },
        { "label": "Duration (ms)", "field": "durationMs" }
      ]
    },
    {
      "title": "Business Logic Validation",
      "dataFrom": "validateBusinessLogic",
      "layout": "bullets"
    }
  ]
}
```

And the matching `consolidate-run-results.json` addition needed to make
`extractAdfDetails`'s `data` available at all:

```json
{
  "stepNames": ["genUsersCsv", "gpgEncryptCsv", "waitForTrigger", "executeAdf", "pollAdf", "extractAdfDetails", "..."],
  "embedArtifacts": {
    "extractAdfDetails": "adf-run-details.json"
  }
}
```

## Out of scope

- No multi-step aggregation within a single section — `dataFrom` names
  exactly one step; cross-step joins aren't requested and add real
  complexity for no asked-for benefit.
- No general templating language or new dependency (Handlebars, Mustache,
  etc.) — the declarative `sections` config covers everything asked for
  without adding a dependency this repo doesn't otherwise need.
- No automatic data-shape detection — an embedded/output step whose data
  isn't named by a `section` simply doesn't appear in the custom-layout
  report (this is the tradeoff of "pure declarative config" over
  "auto-detect + override," which was the explicitly chosen option).
- No `itemTitleField` customization for bullets-over-arrays (sub-heading is
  always `Item N`) — a smaller, scoped decision to avoid one more config
  knob; can be added later if the plain index reads poorly in practice.
- `embedArtifacts` only supports one artifact per step — a step that
  writes multiple artifacts and needs more than one embedded would need a
  follow-up change; no current step in this repo does that.
