# Confluence Join Sections + Gantt Duration Filter — Design

## Purpose

Two more additions to `publish-to-confluence`'s `sections` config:

1. **A `type: 'join'` section** — combines rows from multiple named steps'
   array data into one table. Sources sharing a configured `keyField`
   value merge into one row (outer-join semantics); sources without a
   `keyField` contribute independent rows, populated only in their own
   columns. This is deliberately *not* a strict relational join: there is
   no reliable field connecting individual inbound blob files to
   individual outbound blob files in this pipeline today (confirmed with
   the user — "the files are just from blobs," no shared pipeline-run
   ID), so the mechanism supports both a real per-key merge (when a
   shared key exists) and a plain union (when it doesn't), without
   fabricating a join key that isn't there.
2. **`gantt.minDurationS`** — drops bars shorter than a threshold before
   building the Mermaid chart, since real ADF runs can produce far more
   short activities than a gantt chart can usefully display. A
   `sectionField`/`groupBy` group left with zero bars after filtering is
   omitted entirely (no empty section heading).

Both are additive to `steps/publish-to-confluence.ts`'s existing
`sections` system — no new files, no changes to `consolidate-run-results`
or any step outside this one.

## Part 1: `type: 'join'` sections

### Config

```ts
export interface JoinSource {
  /** Step name, matching ConsolidatedStepEntry.stepName in the results JSON. */
  dataFrom: string;
  /** Which part of that step's entry to read. Default 'outputs'. */
  source?: 'outputs' | 'data';
  /** Dot-path within the selected source to the array to join from. */
  arrayPath?: string;
  /**
   * Dot-path (per item). When set, items from this source merge into a
   * row shared with any other source's item resolving the same key
   * value (outer-join: a key present in only one source still gets a
   * row, with every other source's columns blank). When omitted, every
   * item from this source becomes its own independent row, with every
   * other source's columns blank — this is the "just show both, no
   * shared key" case.
   */
  keyField?: string;
  /** Dot-paths (per item) to extract, with display labels — same shape as every other section's `fields`, including `format`/`decimals`. */
  fields: ReportField[];
}
```

`ReportSection` changes:

```ts
  /** Default 'data'. 'static' ignores every other data-section field except title/html. 'join' ignores dataFrom/source/arrayPath/layout/fields/groupBy/gantt — see `join` below. */
  type?: 'data' | 'static' | 'join';
  ...
  /** Required when type is 'join'. Each source's array data (independently resolved the same way a plain section's dataFrom/source/arrayPath is) contributes columns and/or merges into shared rows. */
  join?: JoinSource[];
```

### Mechanism

`renderSection` gains a `type === 'join'` branch, checked immediately
after the existing `type === 'static'` branch and before the
`dataFrom`/`groupBy`/`layout` logic — a join section never touches
`section.dataFrom` itself (each `JoinSource` has its own `dataFrom`), so
it must short-circuit before that code runs, the same way `static`
already does.

**Refactor required first:** the `dataFrom`/`source`/`arrayPath`
resolution currently inlined at the top of `renderSection` (step lookup,
`source: 'data'`-without-embedded-data check, `arrayPath` resolution)
becomes a standalone function, `resolveSectionData(dataFrom, source,
arrayPath, result, sectionTitle)`, reused both by `renderSection`'s main
body and by each `JoinSource` — this avoids duplicating that resolution
logic (and its three error messages) for every join source. No behavior
change to the existing error messages or the main (non-join) path.

**`renderJoinSection(section, result)`:**

1. Throws if `section.join` is missing or empty:
   `section "<title>": type "join" requires a non-empty "join" array`.
2. Builds the full column list up front: every source's `fields`,
   concatenated in source order, each column keyed internally by
   `"<sourceIndex>.<fieldIndex>"` (not by label — two sources are allowed
   to reuse the same display label, e.g. both calling a column "Path",
   without colliding, since internal storage never keys off the label).
3. For each source, in order: resolve its array via
   `resolveSectionData(src.dataFrom, src.source, src.arrayPath, result,
   section.title)` (throws the same `no step named "..."` / `has no
   embedded "data"` errors as any other section, since it's the same
   helper); throws `section "<title>": join source "<dataFrom>" requires
   array data` if the resolved value isn't an array.
4. For each item in that array, resolve its `fields` into rendered cells
   (via the existing `renderFieldValue`, so `format`/`decimals` work
   identically to every other section type).
   - If `src.keyField` is set: resolve the key (via `resolveFieldPath`,
     stringified, `?? ''` for a missing value — same convention as
     `groupBy`'s key resolution). If a row for that key already exists
     (from this or an earlier source), merge this source's cells into it
     (overwriting only this source's own columns). Otherwise, start a new
     row for that key, in order of first appearance across all keyed
     sources processed so far.
   - If `src.keyField` is absent: append a new independent row (this
     item's own columns populated, no others) — never merged with
     anything.
5. Final row order: every keyed row (in order of first appearance), then
   every unkeyed row (in the order their source items were processed).
6. Renders one `<table>`: header from the column list's labels, one
   `<tr>` per final row, `<td>` per column (the row's own rendered cell,
   or an empty string if that column doesn't apply to this row).

Wrapped the same way every other section is:
`` `<h2>${escapeXhtml(section.title)}</h2>${renderJoinSection(...)}` ``.

### Example (matches the union case discussed with the user)

```json
{
  "title": "Inbound / Outbound Files",
  "type": "join",
  "join": [
    {
      "dataFrom": "uploadPayload",
      "source": "data",
      "fields": [
        { "label": "Inbound Path", "field": "blobPath" },
        { "label": "Inbound Size", "field": "sizeBytes", "format": "bytes" }
      ]
    },
    {
      "dataFrom": "verifyRowCount",
      "source": "data",
      "fields": [
        { "label": "Outbound Rows", "field": "rowCount" }
      ]
    }
  ]
}
```

(Illustrative only — `uploadPayload`/`verifyRowCount` don't embed array
`data` today, since each currently only handles one file per config; if
they're later configured with multiple `files` entries, embedding each
step's own per-file summary array via `consolidate-run-results`'
`embedArtifacts` — same-stage only, per the cross-stage caveat already
documented in the prior spec — is what would make a real multi-row join
possible. No step or `embedArtifacts` change is part of this task; this
is a config-authoring note for whoever wires up a real multi-file config
later.)

### Out of scope

- No multi-field composite keys (`keyField` is exactly one dot-path per
  source) — not asked for, and the "no shared key today" reality means a
  composite key wouldn't have data to key on anyway.
- No join-type selection (inner/left/right/outer) — always full outer
  (every item from every source produces or contributes to a row; nothing
  is ever dropped for lacking a match). This is the only sensible default
  given sources without a `keyField` are unkeyed by design.
- No aggregation (sum/count) across merged rows — a merge always
  overwrites, never combines, colliding values.
- No validation that two sources' `keyField`s are "the same kind of
  thing" — if a config joins on unrelated key spaces, rows simply won't
  merge (each key value that doesn't recur elsewhere just becomes its own
  row), which is a config-authoring mistake, not a runtime error to guard
  against.

## Part 2: `gantt.minDurationS`

### Config

```ts
export interface GanttConfig {
  taskField: string;
  startField: string;
  durationField?: string;
  endField?: string;
  sectionField?: string;
  /** Bars whose resolved duration is shorter than this many seconds are dropped before the chart is built. A sectionField/groupBy group left with zero bars after filtering is omitted entirely (no empty heading/section). */
  minDurationS?: number;
}
```

### Mechanism

Small refactor to `renderGanttSection` needed to filter *before*
formatting: today, `resolveGanttEnd` returns the already-Mermaid-formatted
(Z-stripped) end-time string directly, so there's no `Date`/duration
value available to filter on afterward. Rename it `resolveGanttEndDate`,
returning a `Date` instead of a string (same resolution logic — `endField`
takes precedence over `startField`+`durationField`, same "no resolvable
end time" error, unchanged); the caller (`renderGanttSection`) computes
`durationMs = endDate.getTime() - startDate.getTime()` and formats both
start/end via the existing `toMermaidTimestamp` itself. This is an
internal-only signature change — `resolveGanttEndDate` isn't exported or
unit-tested directly, and every existing test's rendered output (the
final Mermaid text) is unaffected, since the formatted strings produced
are identical to today's.

After computing each bar's `durationMs` alongside its `sectionKey`/`line`,
filter the bars array: `bar.durationMs >= (gantt.minDurationS ?? 0) *
1000` (omitting the filter entirely — i.e., keeping everything — when
`minDurationS` is unset, matching every other optional-field convention
in this file). Filtering happens *before* `partitionByKey` groups bars
into Mermaid `section` blocks, so a group whose every bar was filtered
out simply never appears in the output — no special-case code needed,
since `partitionByKey` only ever produces entries for keys it actually
saw among the (already-filtered) bars it's given.

No new error cases: a `minDurationS` filtering out every bar in the whole
section produces a syntactically valid, empty Mermaid gantt chart (just
the `gantt`/`dateFormat`/`axisFormat`/`title` lines, no bars) — not an
error. This matches the existing tolerant style elsewhere in this file
(e.g., an empty `table` section with `fields` omitted renders a
zero-column header rather than throwing).

### Example

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
    "sectionField": "pipelineRunId",
    "minDurationS": 5
  }
}
```

## Testing

**Part 1 (`join`):** extends `steps/publish-to-confluence.test.ts` with:
a test for two sources sharing a `keyField` merging into one row per key,
in order of first appearance; a test for two sources with no `keyField`
on either producing independent, non-merged rows (the union case); a test
mixing one keyed and one unkeyed source in the same join; the three error
cases (`join` missing/empty, unknown `dataFrom` — reusing
`resolveSectionData`'s existing error, a non-array source); and a test
confirming two sources reusing the same field `label` don't collide
(distinct columns, not one overwriting the other).

**Part 2 (`minDurationS`):** a test with bars above/below/at the threshold
(inclusive boundary — `>=`) confirming only the qualifying bars appear; a
test where an entire `sectionField` group's bars all fall below the
threshold, confirming that `section <key>` heading doesn't appear at all
(not an empty section); a test confirming `minDurationS` omitted preserves
today's exact behavior (no test currently asserts a duration filter, so
this is really just confirming no regression — existing gantt tests
continue to pass unmodified since they never set `minDurationS`).

## Out of scope

- No change to any step other than `publish-to-confluence.ts` — the
  "real" multi-file inbound/outbound data this could eventually join
  against would require new step/config work (per-file embedded arrays,
  a real shared key), explicitly deferred per the Part 1 example's note.
- No UI/config for choosing a different duration unit for
  `minDurationS` (always seconds, matching `duration-s`'s existing
  field-formatter convention in this same file).
