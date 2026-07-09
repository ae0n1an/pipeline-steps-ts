# Payload Validation Steps (Group C) — Design

## Purpose

This is Group C, the final group of a larger batch of pipeline-step work
(Group A — multi-file support for `generate-synthetic-csv`/`gpg-encrypt-file`
— and Group B — blob storage steps — are both complete). Group C adds three
storage-agnostic validation steps that operate on local file paths (which
may come from a previous step's output, e.g. `verify-and-download-blob`, or
anywhere else):

1. `verify-row-count` — checks a file's row/entry count against a min/max
   range.
2. `validate-json-schema` — validates a JSON file against a caller-supplied
   JSON Schema.
3. `validate-business-logic` — checks declarative cross-file rules between
   a CSV and a JSON file (e.g. inbound payload CSV vs. outbound JSON).

None of these three steps talk to Azure Blob Storage or any other external
system — they are pure local-file steps, consistent with `generate-synthetic-csv`
and `gpg-encrypt-file`.

## Shared execution model

All three steps process their configured `files` array **sequentially,
failing fast** — the same convention as Group A's `generate-synthetic-csv`/
`gpg-encrypt-file`, not Group B's concurrent/wait-for-all pattern, because
these are local, synchronous file reads rather than independent network
calls. On the first entry that fails, the step throws immediately, naming
that entry's index and `name` in the error message: `` File entry {index}
("{name}") failed: {message} `` (verbatim format, matching Group A's
established convention). Output keys are flattened, prefixed by each
entry's `name` (or `f{index}` if omitted), plus a `totalFiles` count.

## Shared helper: `steps/lib/csv.ts`

A small RFC4180-style CSV parser — the second deliberate exception to
"every step is fully standalone" (the first being `steps/lib/blob-client.ts`
from Group B). Needed because naive newline-splitting would miscount rows
if a field contains an embedded newline, which `generate-synthetic-csv`'s
own `csvEscape` can legitimately produce (any field containing `,`, `"`,
or `\n` gets quoted). Both `verify-row-count` and `validate-business-logic`
need to read and correctly parse CSV content, so the parser lives here
once.

```ts
export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(content: string): ParsedCsv;
```

A character-by-character state machine: tracks whether the cursor is
inside a quoted field, handles `""` as an escaped quote, treats unquoted
`,` as a field separator and unquoted `\n` (with `\r` stripped) as a row
separator. `rows` are objects keyed by the header row's column names.

## Step 1: `verify-row-count`

### Config

```ts
interface RowCountEntry {
  name?: string;
  filePath: string;
  /** Defaults from the file extension (.csv -> csv, .json -> json). */
  format?: 'csv' | 'json';
  minRows?: number;
  maxRows?: number;
}
interface VerifyRowCountConfig {
  files: RowCountEntry[];
}
```

### Behavior

For each entry (sequential, fail-fast): read the file, count rows
according to `format` (explicit or inferred from extension). CSV row count
is `parseCsv(content).rows.length` (excludes the header row). JSON row
count requires the file's top-level JSON value to be an array; count is
its `.length` — a JSON file whose top-level value isn't an array is a
failure for that entry (nested array extraction, e.g. by a JSON-path-like
config, is out of scope; the whole file must be an array at the top
level). An entry fails if `rowCount < minRows` (when set) or
`rowCount > maxRows` (when set); an entry with neither bound set always
passes (row count is just reported).

### Outputs

Per entry: `{name}_rowCount`, `{name}_status`. Summary: `totalFiles`.

## Step 2: `validate-json-schema`

### Config

```ts
interface SchemaEntry {
  name?: string;
  filePath: string;
  schemaPath: string;
}
interface ValidateJsonSchemaConfig {
  files: SchemaEntry[];
}
```

### New dependency

`ajv` (^8.20.0) — hand-rolling was rejected. Unlike the small glob subset
hand-rolled in Group B's `remove-blob-files` (a genuinely small, bounded
problem), JSON Schema is a large, precisely-specified standard (types,
`required`, nested `$ref`, `oneOf`/`anyOf`, string/number `format`
validators, etc.); correctly reimplementing even a useful subset carries
high bug risk for little benefit over the de facto standard library.

### Behavior

For each entry (sequential, fail-fast): read and `JSON.parse` both the
schema file (`schemaPath`) and the data file (`filePath`), compile the
schema with `ajv` (default constructor — JSON Schema draft-07; draft
2020-12 support is a documented out-of-scope follow-up, not built now),
and validate. On failure, the entry's error message includes every ajv
validation error (instance path + message), not just the first.

### Outputs

Per entry (success only — failure throws): `{name}_status`. Summary:
`totalFiles`.

## Step 3: `validate-business-logic`

### Config

```ts
interface BusinessLogicEntry {
  name?: string;
  csvPath: string;
  jsonPath: string;
  csvKeyField: string;
  jsonKeyField: string;
  rules: Rule[];
}

type Rule =
  | { type: 'rowCountMatches'; tolerance?: number }
  | { type: 'allCsvRowsHaveJsonMatch' }
  | { type: 'allJsonEntriesHaveCsvMatch' }
  | { type: 'fieldsEqual'; csvField: string; jsonField: string };

interface ValidateBusinessLogicConfig {
  files: BusinessLogicEntry[];
}
```

### Behavior

For each entry (sequential, fail-fast across entries): parse the CSV via
`steps/lib/csv.ts`; parse the JSON, requiring a top-level array of
objects (same requirement as `verify-row-count`'s JSON mode). Build a
lookup from each side keyed by `csvKeyField`/`jsonKeyField` respectively,
comparing key values as strings (`String(csvValue) === String(jsonValue)`)
since CSV values are always strings and JSON values may not be.

Then run **every** configured rule for that entry (not stopping at the
first violation) and collect every violation:

- `rowCountMatches`: CSV row count vs. JSON array length, optionally
  within `tolerance` (absolute difference).
- `allCsvRowsHaveJsonMatch`: every CSV row's key has a corresponding JSON
  entry.
- `allJsonEntriesHaveCsvMatch`: every JSON entry's key has a corresponding
  CSV row.
- `fieldsEqual`: for every row pair matched by key, `String(csvRow[csvField])
  === String(jsonEntry[jsonField])`.

If any rule produced any violation, the entry fails — the thrown error
(after wrapping with the `File entry {index} ("{name}") failed:` prefix)
lists every violation found for that entry, not just the first, so a
single run surfaces the complete picture of what's wrong with that file
pair. This "collect all violations within one entry" behavior is
orthogonal to the "sequential, fail-fast across entries" model: the first
*entry* with any violation still stops the step before later entries are
attempted, but within that one entry, all rules are checked.

### Outputs

Per entry (success only): `{name}_status`, `{name}_rulesChecked` (count
of rules configured for that entry). Summary: `totalFiles`.

## Out of scope

- No concurrent processing in any of the three steps (sequential fail-fast
  only, per the shared execution model).
- No nested-array extraction for JSON row counting (`verify-row-count`) —
  the JSON file's top-level value must itself be the array.
- No JSON Schema draft 2020-12 support (draft-07 only, via ajv's default
  export).
- No custom-code validator option for `validate-business-logic` — only the
  four declarative rule types listed above. This was an explicit choice
  over a "point at a validator module" design, to keep every step's config
  as pure JSON data, consistent with the rest of this repo.
- No aggregate-then-throw failure mode across files in any of the three
  steps (unlike `trigger-adf-pipeline`/Group B) — sequential fail-fast
  only, per the shared execution model's local-file-I/O rationale.
