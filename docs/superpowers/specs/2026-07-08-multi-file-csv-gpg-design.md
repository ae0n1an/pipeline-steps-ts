# Multi-File Config for generate-synthetic-csv and gpg-encrypt-file — Design

## Purpose

This is Group A of a larger batch of pipeline-step work (blob storage
operations and payload validation steps are Groups B and C, specced
separately). Group A modifies the two existing steps so a single step
invocation can produce/process multiple files, each with its own config —
e.g. one `generate-synthetic-csv` call producing several distinct synthetic
payloads, or one `gpg-encrypt-file` call encrypting several files with
different keys and output names. This unblocks realistic multi-payload
pipelines for Groups B/C to build on.

## Config shape

Both steps move from a flat single-file config to `{ files: [...] }`, where
each array entry is the same shape as today's top-level config, plus an
optional `name` used to prefix that entry's output keys (defaults to
`f{index}`, mirroring the `p{index}` pattern already used by
`trigger-adf-pipeline`). Neither step has shared top-level defaults — every
entry is fully self-contained. This is a **breaking change** to both
steps' config shape; there is no dual-shape backward-compatibility path.

```ts
// generate-synthetic-csv.ts
export interface GenerateCsvConfig {
  files: FileConfig[];
}
interface FileConfig {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  fileName?: string;
  rowCount?: number | string;
  seed?: number | string;
  columns: ColumnConfig[];
}
```

```ts
// gpg-encrypt-file.ts
export interface GpgEncryptConfig {
  files: FileEntryConfig[];
}
interface FileEntryConfig {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  inputPath: string;
  publicKeyArmored?: string;
  keyVaultUrl?: string;
  secretName?: string;
  recipient?: string;
  outputFileName?: string;
  armor?: boolean;
  cipherAlgo?: string;
}
```

`ColumnConfig` (generate-synthetic-csv) and the GPG key-resolution logic
(`publicKeyArmored` / `keyVaultUrl`+`secretName`) are unchanged from today —
only the wrapping structure changes.

## Execution

Both steps process `config.files` in a plain sequential `for` loop — no
`Promise.all`, no dependency-injection seam. This isn't concurrent I/O like
`trigger-adf-pipeline`'s network polling; CSV generation and GPG encryption
are synchronous, CPU-bound, local operations, so parallelism would add
complexity (async `execFile` instead of `execFileSync`, keyring-concurrency
review) without a real wall-clock win.

**Failure handling: fail-fast.** On the first entry that fails (empty
`columns`, missing `inputPath`, unresolvable GPG key, etc.), the step
throws immediately — same as today's single-file behavior — except the
error message now names which entry failed (its `name` and index), e.g.
`File entry 1 ("usersCsvGpg") failed: <original error message>`. Entries
after the failing one are not attempted. This matches the existing
single-file steps' fail-fast style and avoids doing further local work
after a config bug is already known.

## Outputs & artifacts

Flattened `StepResult.outputs`, prefixed by each entry's `name`/`f{index}`,
plus a `totalFiles` count:

- **generate-synthetic-csv**: `{name}_csvPath`, `{name}_fileName`,
  `{name}_rowCount`, `{name}_columnNames`, `{name}_seed`,
  `{name}_sizeBytes`
- **gpg-encrypt-file**: `{name}_encryptedPath`, `{name}_fileName`,
  `{name}_recipient`, `{name}_sizeBytes`, `{name}_sourceFile`

`artifacts` becomes the full list of files produced across all entries
(previously always a single-element array; now potentially multi-element —
one path per successfully processed entry before any fail-fast throw).

## Breaking-change fallout

Because outputs are now name-prefixed instead of flat, existing
cross-step/cross-stage references must be updated. Both example configs get
explicit, stable `name`s (not the default index) so these references read
clearly:

- `configs/generate-users-csv.json` becomes:
  ```json
  {
    "files": [
      {
        "name": "usersCsv",
        "fileName": "users.csv",
        "rowCount": 250,
        "seed": 42,
        "columns": [ /* unchanged */ ]
      }
    ]
  }
  ```
- `configs/gpg-encrypt-users-csv.json` becomes:
  ```json
  {
    "files": [
      {
        "name": "usersCsvGpg",
        "inputPath": "{{steps.genUsersCsv.outputs.usersCsv_csvPath}}",
        "publicKeyArmored": "{{env.GPG_PUBLIC_KEY}}",
        "outputFileName": "users.csv.gpg",
        "armor": false
      }
    ]
  }
  ```
  Note the input reference changes from `outputs.csvPath` to
  `outputs.usersCsv_csvPath`.
- `.pipelines/azure-pipelines.yml`'s `Deliver` stage variable:
  ```yaml
  encryptedFile: $[ stageDependencies.Generate.build_data.outputs['gpgEncryptCsv.gpgEncryptCsv.usersCsvGpg_encryptedPath'] ]
  ```
  (was `...encryptedPath`, now `...usersCsvGpg_encryptedPath`).
- `README.md`'s "How outputs flow" section gains a note on the per-file
  naming convention, matching the note already added for
  `trigger-adf-pipeline`.
- `README.md`'s example CLI invocations (`## Running` section) are updated
  to describe the new `files`-array config shape.

## Error message detail

The fail-fast error thrown from either step wraps the original error with
context identifying the failing entry:

```
File entry {index} ("{name}") failed: {original error message}
```

This is a plain `throw new Error(...)` — no change to the runner's
catch/report mechanism (`run-step.ts` already turns any thrown `Error` into
an ADO `##vso[task.logissue type=error]` + failed `output.json`).

## Out of scope

- No parallel processing (explicitly rejected — sequential only).
- No aggregate-then-throw failure mode (explicitly rejected — fail-fast
  only, unlike `trigger-adf-pipeline`'s wait-for-all).
- No backward-compatible single-file config shape — this is a clean
  breaking change with all consumers (example configs, YAML) updated in
  the same change.
- No shared top-level defaults across `files` entries in either step.
