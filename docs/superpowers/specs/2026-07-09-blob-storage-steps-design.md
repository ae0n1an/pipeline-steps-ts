# Blob Storage Steps (Group B) — Design

## Purpose

This is Group B of a larger batch of pipeline-step work (Group A — multi-file
support for `generate-synthetic-csv`/`gpg-encrypt-file` — is complete; Group
C — payload validation steps — is specced separately). Group B adds three
new steps for moving files to/from/around Azure Blob Storage:

1. `remove-blob-files` — delete blobs matching a glob path pattern.
2. `upload-to-blob` — upload local file(s) to blob storage (e.g. encrypted
   payloads from `gpg-encrypt-file` to an inbound container).
3. `verify-and-download-blob` — verify expected blob(s) exist and download
   them.

## Shared infrastructure

### New dependencies

`@azure/storage-blob` and `@azure/identity` are added as regular (not
optional) dependencies — this is the primary auth route for all three
steps, not a fallback like the GPG step's optional Key Vault SDK route.

### Auth

All three steps authenticate via `DefaultAzureCredential` against an
`accountUrl` (e.g. `https://mystorageaccount.blob.core.windows.net`) — no
connection string or SAS token handling. This relies on the pipeline's
service connection or a managed identity holding the appropriate Storage
Blob Data role.

### Shared client helper: `steps/lib/blob-client.ts`

A small shared module — the one deliberate exception to this repo's
"every step is a fully standalone module" framing (the README gets a
one-line note about it). It exports:

```ts
export interface BlobEntry {
  name: string;
  lastModified?: Date;
  sizeBytes: number;
}

export interface BlobStorageClient {
  listBlobs(containerName: string, prefix?: string): AsyncIterable<BlobEntry>;
  blobExists(containerName: string, blobPath: string): Promise<boolean>;
  deleteBlob(containerName: string, blobPath: string): Promise<void>;
  uploadBlob(
    containerName: string,
    blobPath: string,
    localFilePath: string,
    overwrite: boolean,
  ): Promise<{ url: string; sizeBytes: number }>;
  downloadBlob(
    containerName: string,
    blobPath: string,
    localFilePath: string,
  ): Promise<{ sizeBytes: number }>;
}

export function createAzureBlobStorageClient(accountUrl: string): BlobStorageClient;
```

`createAzureBlobStorageClient` wraps `BlobServiceClient` +
`DefaultAzureCredential`. Each step's real `run()` uses it by default;
**unit tests inject a fake in-memory `BlobStorageClient`** instead of
hitting real Azure — there's no live Storage account available to test
against (unlike the GPG step, which can shell out to a real local `gpg`
binary). This mirrors `trigger-adf-pipeline`'s `FetchLike`/`AdfDeps`
dependency-injection seam: the real client is the default, tests pass a
fake.

### Shared config convention

Every step has top-level `accountUrl` + `containerName` as shared
defaults, overridable per-item — the same shape as
`trigger-adf-pipeline`'s `subscriptionId`/`resourceGroup`/`factoryName`
pattern, since the connection target here is analogous to ADF's factory
identity (a shared destination), not analogous to the GPG step's per-file
key (a security-sensitive value that must never silently fall back).

### Shared execution model

All three steps process their configured items **concurrently, waiting for
all before deciding pass/fail, then throwing one aggregated error** if any
item failed — the same model as `trigger-adf-pipeline`, chosen because
these are independent network calls where one item's failure or slowness
shouldn't block or abort siblings. Per-item outputs are flattened and
prefixed by that item's `name` (or `f{index}` by index if omitted), plus a
`total*`/`succeededCount`/`failedCount` summary, plus a JSON summary
artifact with full per-item detail (since `StepResult.outputs` values must
stay within `Record<string, string | number | boolean>` — no arrays).

## Step 1: `remove-blob-files`

### Config

```ts
interface PatternEntry {
  name?: string;
  pattern: string;           // glob, e.g. "inbound/2026-*/*.gpg"
  accountUrl?: string;       // per-entry override
  containerName?: string;    // per-entry override
}
interface RemoveBlobFilesConfig {
  accountUrl?: string;
  containerName?: string;
  patterns: PatternEntry[];
}
```

### Matching

A minimal hand-rolled glob → `RegExp` converter (no new dependency for
this — `minimatch` was considered and rejected in favor of a small,
fully-tested in-repo implementation covering just this repo's realistic
needs):

- `*` matches any run of characters **except** `/`.
- `**` matches any run of characters **including** `/`.
- All other characters are treated as literal (regex-escaped).

For efficiency, the literal prefix before the first wildcard character in
each pattern is passed as the `prefix` argument to `listBlobs`, so Azure
Storage's server-side prefix filtering narrows the listing before the glob
match runs client-side against the (usually much smaller) result set.

### Behavior

No age filtering — this is pure pattern-based cleanup, not
retention-policy enforcement. For each pattern entry (processed
concurrently across entries): list + prefix-filter, glob-match
client-side, then delete every match **concurrently** (`Promise.all` of
delete calls within that entry). Zero matches is not an error.

### Outputs & artifacts

Per entry: `{name}_matchedCount`, `{name}_deletedCount`, `{name}_status`.
Summary: `totalPatterns`, `succeededCount`, `failedCount`. Artifact:
`delete-summary.json` listing every deleted blob path per entry (outputs
can't hold arrays).

## Step 2: `upload-to-blob`

### Config

```ts
interface UploadEntry {
  name?: string;
  localPath: string;
  blobPath: string;
  overwrite?: boolean;       // default true
  accountUrl?: string;
  containerName?: string;
}
interface UploadToBlobConfig {
  accountUrl?: string;
  containerName?: string;
  files: UploadEntry[];
}
```

### Behavior

Overwrites the target blob by default (the common "upload the latest
payload" case); `overwrite: false` opts into strict no-clobber (fails that
entry if the blob already exists — checked via `blobExists` before
uploading). Processed concurrently across entries, wait-for-all.

### Outputs & artifacts

Per entry: `{name}_blobPath`, `{name}_blobUrl`, `{name}_sizeBytes`,
`{name}_status`. Summary: `totalFiles`, `succeededCount`, `failedCount`.
Artifact: `upload-summary.json`.

## Step 3: `verify-and-download-blob`

### Config

```ts
interface VerifyEntry {
  name?: string;
  blobPath: string;
  localPath?: string;        // defaults to ctx.outDir/<basename of blobPath>
  required?: boolean;        // default true
  accountUrl?: string;
  containerName?: string;
}
interface VerifyAndDownloadConfig {
  accountUrl?: string;
  containerName?: string;
  files: VerifyEntry[];
}
```

### Behavior

Explicit blob paths only — no glob support (that's `remove-blob-files`'s
job; blurring the two would complicate "required against a pattern that
matches zero blobs" semantics). For each entry: check existence via
`blobExists`. If present, download to `localPath`. If absent and
`required` (default `true`), that entry fails (included in the aggregated
error). If absent and `required: false`, recorded as
`{name}_exists = false` with no download attempt and no failure.
Processed concurrently across entries, wait-for-all.

### Outputs & artifacts

Per entry: `{name}_exists`, `{name}_localPath`, `{name}_sizeBytes`,
`{name}_status`. Summary: `totalFiles`, `succeededCount`, `failedCount`.
Artifact: `verify-summary.json`.

## Testing strategy

Every step's core logic is exercised against a fake in-memory
`BlobStorageClient` (an object literal backed by a `Map<string, Buffer>`
per container, implementing the same interface `createAzureBlobStorageClient`
returns) — no real Azure Storage account, no emulator (e.g. Azurite)
required. The glob-matching function in `remove-blob-files` is unit tested
directly (pure function, no I/O).

## Out of scope

- No age-based/retention filtering in `remove-blob-files` (pattern match
  only).
- No glob support in `verify-and-download-blob` (explicit paths only).
- No SAS token or connection-string auth route (DefaultAzureCredential
  only).
- No cross-container copy operation (each step's `containerName` is a
  single target per item; moving a blob between containers would be two
  steps — download then upload — composed in YAML, not a new step).
- No retry/backoff logic beyond whatever the Azure SDK does internally by
  default — not treated as a requirement here, unlike
  `trigger-adf-pipeline`'s explicit poll-retry-on-transient-error logic,
  since these are one-shot calls (list/exists/delete/upload/download), not
  long-running polling.
