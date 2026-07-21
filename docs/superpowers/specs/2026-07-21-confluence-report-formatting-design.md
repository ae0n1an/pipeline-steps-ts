# Confluence Report Rich Formatting — Design

## Purpose

The `2026-07-20-confluence-report-templating-design.md` spec gave
`publish-to-confluence` a declarative `sections` config (`dataFrom`,
`source`, `arrayPath`, `layout: table|bullets|keyvalue`, `fields`) that
replaced the single fixed "Step Results" table. That solved *what* data
appears and in what shape, but every value still renders as a raw,
unformatted string, arrays can't be split by a parent/child relationship,
there's no way to visualize activity timing, and every section must be
backed by step data.

This closes those gaps, purely as an extension of the existing `sections`
config — no new step, no new external dependency, no breaking change to
any current config or test:

1. **Field formatting** — per-field `format` (UTC→AEST timestamps, ms→s
   durations, bytes→KB/MB/GB, status lozenges) plus a `decimals` control.
2. **Grouping** — split an array section into one sub-table per distinct
   value of a field (e.g. per parent pipeline run).
3. **Gantt layout** — render ADF activity timing as a Mermaid gantt chart,
   embedded as a Confluence code-block macro.
4. **Static sections** — a section type for arbitrary authored content, not
   tied to any step's data.
5. **Table of contents** — Confluence's native TOC macro, one config flag.

## Config schema

```ts
export interface ReportField {
  label: string;
  field: string;                 // dot-path, unchanged from today
  format?: 'timestamp-aest' | 'duration-s' | 'bytes' | 'status' | 'number';
  /** Decimal places for 'bytes' | 'number' | 'duration-s'. Default 1 (0 for 'number'). Ignored by 'timestamp-aest' and 'status'. */
  decimals?: number;
}

export interface GanttConfig {
  taskField: string;
  startField: string;
  /** Duration in ms; used only if endField is absent. */
  durationField?: string;
  /** ISO timestamp; takes precedence over durationField if both resolve. */
  endField?: string;
  /** Dot-path; groups bars into separate Mermaid `section` blocks. */
  sectionField?: string;
}

export interface ReportSection {
  /** Default 'data'. */
  type?: 'data' | 'static';
  title: string;

  // type: 'data'
  dataFrom?: string;
  source?: 'outputs' | 'data';
  arrayPath?: string;
  /** Default 'keyvalue'. */
  layout?: 'table' | 'bullets' | 'keyvalue' | 'gantt';
  fields?: ReportField[];
  /** Dot-path; splits array data into one <h3> sub-heading + table/bullets per distinct value, in order of first appearance. Requires array data; incompatible with layout: 'gantt'. */
  groupBy?: string;
  /** Required when layout is 'gantt'. */
  gantt?: GanttConfig;

  // type: 'static'
  /** Required when type is 'static'. Raw Confluence storage-format content, inserted unescaped under <h2>{title}</h2>. */
  html?: string;
}

export interface PublishToConfluenceConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey: string;
  pageTitle: string;
  parentPageId?: string;
  resultsPath: string;
  /** Inserts Confluence's native Table of Contents macro as the very first element on the page, before the Run Summary table. Default false. */
  includeToc?: boolean;
  sections?: ReportSection[];
}
```

Nothing here changes behavior for an existing config: `format`, `groupBy`,
`gantt`, `type`, and `includeToc` are all optional/absent-by-default, and
`layout: 'gantt'` / `type: 'static'` are new enum values a v1 config never
used.

## 1. Field formatters

A small pure-function registry, `formatValue(value, format, decimals):
string`, applied to a field's *resolved leaf value* wherever `fields` is
used (`table`, `bullets`, `keyvalue`). A field with no `format` behaves
exactly as today: `escapeXhtml(String(value))`.

`format` only applies when the resolved value is a primitive. If a field's
resolved value is itself an array or plain object, `format` is ignored and
the existing nested cell-bullet renderer handles it unchanged (there's no
per-key `fields` config at that inner depth to know what format each
nested key would even want) — this matches today's behavior for anyone
not using `format` at all.

- **`timestamp-aest`**: parses `value` as an ISO/UTC datetime string,
  formats it in the `Australia/Sydney` IANA zone via
  `Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', ... })`, and
  appends the zone abbreviation Intl resolves for that instant (`AEST` or
  `AEDT` — this is how the Oct/Apr DST transition is handled correctly
  without a manual offset table). Output: `2026-07-21 14:32:05 AEST`.
  `null`/`undefined`/unparseable input renders as an empty cell, same
  convention as an absent field today.
- **`duration-s`**: `Number(value) / 1000`, `.toFixed(decimals ?? 1)`,
  suffixed `s` → `"4.2s"`. Assumes the source field is milliseconds
  (true for every `durationMs`/`durationInMs` field in this repo's step
  outputs).
- **`bytes`**: binary (1024-based) auto-scaling — chooses the largest unit
  among B/KB/MB/GB where the value is ≥ 1, `.toFixed(decimals ?? 1)` →
  `"4.2 MB"`.
- **`number`**: `Number(value).toFixed(decimals ?? 0)`.
- **`status`**: ignores `decimals`. Instead of escaped text, emits a
  Confluence status-lozenge macro:
  ```xml
  <ac:structured-macro ac:name="status">
    <ac:parameter ac:name="colour">Green</ac:parameter>
    <ac:parameter ac:name="title">Succeeded</ac:parameter>
  </ac:structured-macro>
  ```
  Color mapping: `Succeeded`→Green, `Failed`→Red, `InProgress`/`Queued`→Blue,
  anything else→Grey (using the raw value, escaped, as the title). This is
  the one formatter that bypasses `escapeXhtml` for the *value itself*
  because it isn't rendering text — the raw value is still escaped when
  used as the macro's `title` parameter.

An unrecognized `format` string throws immediately during rendering
(`section "<title>": unknown format "<format>" for field "<field>"`) —
this is a config-typo trap, not a data problem, so it should fail loud
rather than silently falling back to plain text.

## 2. Grouping (`groupBy`)

Applies to `table` and `bullets` layouts only. Partitions the resolved
array by the value at `groupBy` (via the existing `resolveFieldPath`
helper), preserving the order groups first appear in the source array.
Renders one `<h3>{group value}</h3>` per partition, followed by that
partition's section body exactly as it would render without grouping
(same `fields`, same layout logic, same formatters).

```json
{
  "title": "ADF Pipeline Runs",
  "dataFrom": "extractAdfDetails",
  "source": "data",
  "arrayPath": "pipelineRuns",
  "layout": "table",
  "groupBy": "parentRunId",
  "fields": [
    { "label": "Pipeline", "field": "pipelineName" },
    { "label": "Status", "field": "status", "format": "status" },
    { "label": "Start (AEST)", "field": "runStart", "format": "timestamp-aest" },
    { "label": "Duration", "field": "durationMs", "format": "duration-s" }
  ]
}
```

`groupBy` on non-array data, or combined with `layout: 'gantt'`, throws
(`section "<title>": groupBy requires array data` /
`groupBy is not supported on layout "gantt"`).

## 3. Gantt layout

`layout: 'gantt'` requires a `gantt` config block and array data. Builds
Mermaid gantt syntax and wraps it in a code-block macro:

```xml
<ac:structured-macro ac:name="code">
  <ac:parameter ac:name="language">mermaid</ac:parameter>
  <ac:plain-text-body><![CDATA[
gantt
    dateFormat  YYYY-MM-DDTHH:mm:ss.SSS
    axisFormat  %H:%M:%S
    title ADF Activity Timeline
    section CopyData
    CopyData_1 : 2026-07-21T09:00:00.000, 2026-07-21T09:00:30.500
    section Lookup
    Lookup_1   : 2026-07-21T09:00:30.500, 2026-07-21T09:00:35.500
  ]]></ac:plain-text-body>
</ac:structured-macro>
```

Rules:
- End time = `endField` if it resolves, else `startField + durationField`ms.
  Neither resolving for an item throws
  (`section "<title>": item <n> has no resolvable end time (need endField or durationField)`).
- Missing `taskField` name on config (not per-item) throws at validation
  time, before any rendering: `gantt layout requires gantt.taskField and
  gantt.startField`.
- `sectionField` groups bars into Mermaid `section <value>` blocks, in
  order of first appearance; absent → everything under one implicit
  section (the chart's `title` line still applies either way).
- Task names have `:` stripped (Mermaid's field separator) before
  insertion; otherwise passed through as literal Mermaid syntax, not
  XHTML-escaped, since it lives inside a CDATA plain-text body.

This renders as a diagram only on Confluence sites with a Mermaid-rendering
app/macro installed; otherwise readers see the code block with the mermaid
source. This is a known, accepted limitation of the "code block" approach.

```json
{
  "title": "ADF Activity Timeline",
  "dataFrom": "extractAdfDetails",
  "source": "data",
  "arrayPath": "activities",
  "layout": "gantt",
  "gantt": {
    "taskField": "activityName",
    "startField": "activityRunStart",
    "durationField": "durationMs",
    "sectionField": "pipelineRunId"
  }
}
```

## 4. Static sections

```json
{ "type": "static", "title": "Release Notes", "html": "<p>Deployed by CI on 2026-07-21.</p>" }
```

Renders `<h2>{title}</h2>{html}`, with `html` inserted **unescaped** — it's
config-authored content (same trust level as every other field in this
step's config; this repo doesn't sanitize any of its own config-supplied
strings). A `static` section with no `dataFrom` needs none — `dataFrom`,
`source`, `arrayPath`, `layout`, `fields`, `groupBy`, `gantt` are all
ignored if present alongside `type: 'static'`. Missing `html` throws
(`section "<title>": type "static" requires html`).

A "Known Defects" section is just an ordinary `type: 'data'` section
pointed at whatever step produces defect data — no special-casing needed;
this is the existing `sections` mechanism doing what it already does.

## 5. Table of contents

`includeToc: true` inserts `<ac:structured-macro ac:name="toc" />` as the
very first element on the page — before the (always-present) Run Summary
table, before any `sections`. Default `false`; omitting it reproduces
today's exact page structure.

## What stays exactly the same

- The top "Run Summary" table (metadata + `generatedAt` + counts) is
  unconditional, same as today, now preceded by the TOC macro only if
  `includeToc` is set.
- When `sections` is omitted or empty, the rest of the page is the
  existing generic "Step Results" table — completely untouched.
- `findExistingPage`/`createPage`/`updatePage`, the artifact-before-network
  write order, and the create-vs-update flow are all untouched.
- Every existing `ReportSection` config (no `format`, no `groupBy`, no
  `gantt`, no `type`) renders byte-for-byte as it does today.

## Error handling summary

All new validation happens synchronously during content rendering, before
`findExistingPage`/`createPage`/`updatePage` are ever called — consistent
with this step's existing "validate everything up front" convention:

| Condition | Error |
|---|---|
| Unknown `format` value | `section "<title>": unknown format "<format>" for field "<field>"` |
| `groupBy` on non-array data | `section "<title>": groupBy requires array data` |
| `groupBy` combined with `layout: 'gantt'` | `section "<title>": groupBy is not supported on layout "gantt"` |
| `layout: 'gantt'` missing `gantt.taskField`/`gantt.startField` | `section "<title>": gantt layout requires gantt.taskField and gantt.startField` |
| Gantt item with no resolvable end time | `section "<title>": item <n> has no resolvable end time (need endField or durationField)` |
| `type: 'static'` missing `html` | `section "<title>": type "static" requires html` |

## Testing

Extends the existing `publish-to-confluence.test.ts` (unit-per-behavior,
matching this repo's TDD convention):

- One test per formatter, including the AEST/AEDT DST boundary
  (e.g. an instant just before and after the Oct/Apr transition).
- `groupBy` on `table` and on `bullets`, plus its two error cases.
- Gantt string generation: `durationField`-derived end time, `endField`
  precedence over `durationField`, `sectionField` grouping, task-name
  colon-stripping, and both error cases.
- Static section rendering and its missing-`html` error.
- `includeToc` present/absent.
- One full-page integration test combining all of the above in a single
  `sections` config, asserting the complete rendered XHTML output.

## Out of scope

- No configurable timezone or unit system — `timestamp-aest` and `bytes`
  are fixed to what was asked for (Australia/Sydney, binary KB/MB/GB).
  Generalizing to an arbitrary IANA zone or decimal/binary unit choice is a
  small, backward-compatible follow-up if another team ever needs it.
- No `duration-min`/other duration units beyond `duration-s` — not asked
  for; add as another named formatter later if needed.
- No image-rendered Mermaid diagrams (headless render + attachment
  upload) — explicitly deferred in favor of the dependency-free code-block
  approach.
- No `groupBy` support for `gantt` layout — `gantt.sectionField` already
  covers "split by parent" *within* one diagram, which is the gantt-native
  equivalent; a further "one gantt chart per group" isn't requested.
- No nested/multi-level `groupBy` (only one grouping field per section).
- No conditional/expression-based formatting (e.g. "red if duration >
  Xs") beyond the fixed `status` lozenge mapping.
- No markdown-to-storage-format conversion for static sections — `html`
  is raw Confluence storage format, same representation the rest of this
  step already produces.
