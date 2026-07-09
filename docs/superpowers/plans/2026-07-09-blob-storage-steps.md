# Blob Storage Steps (Group B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new pipeline steps — `remove-blob-files`, `upload-to-blob`, `verify-and-download-blob` — for moving files to/from/around Azure Blob Storage, backed by a shared `steps/lib/blob-client.ts` helper.

**Architecture:** A new shared module `steps/lib/blob-client.ts` exports a minimal `BlobStorageClient` interface plus two implementations: `createAzureBlobStorageClient` (real, wraps `@azure/storage-blob` + `DefaultAzureCredential`) and `createFakeBlobStorageClient` (in-memory, used by every step's tests). It also exports `resolveBlobTarget`, a shared per-entry/top-level-fallback resolver for `accountUrl`/`containerName`, mirroring `trigger-adf-pipeline`'s `resolveTarget`. Each of the three steps follows `trigger-adf-pipeline`'s orchestration shape: `defineStep` wraps an exported `runAll(config, ctx, clientFactory?)`, which fans out `Promise.all` over independent per-item async functions that never reject (each catches its own errors into a `Result`), waits for all, flattens per-item outputs under a `name`/`f{index}` prefix plus a summary count, writes a JSON summary artifact, and throws one aggregated error if any item failed.

**Tech Stack:** TypeScript, `@azure/storage-blob` ^12.33.0, `@azure/identity` ^4.13.1 (new runtime dependencies — confirmed current versions), `tsx --test` / `node:test` / `node:assert/strict`.

## Global Constraints

- New dependencies: `@azure/storage-blob`, `@azure/identity` (added via `npm install`, not hand-edited into package.json, so `package-lock.json` stays consistent).
- `npm run typecheck` (tsc --noEmit) must pass after every task that touches `.ts` files.
- Auth is `DefaultAzureCredential` only — no connection-string or SAS-token route.
- No age-based filtering in `remove-blob-files` — pattern match only.
- No glob support in `verify-and-download-blob` — explicit blob paths only.
- All three steps process their items **concurrently** (`Promise.all`), **wait for all** before deciding pass/fail, and throw **one aggregated error** naming every failed item — never fail-fast, never sequential (unlike Group A's CSV/GPG steps, which are correctly sequential+fail-fast for local CPU-bound work; these are independent network calls).
- Output keys are flattened and prefixed by each item's `name` (or `f{index}` if omitted), plus `total*`/`succeededCount`/`failedCount` summary keys — same convention as every prior step in this repo.
- Every step's tests run against `createFakeBlobStorageClient()`, never real Azure Storage — there is no live account to test against in this environment.
- Test command: `npm test` (globs `steps/**/*.test.ts`, confirmed to pick up nested `steps/lib/*.test.ts` in this environment).

---

## File Structure

- **Create:** `steps/lib/blob-client.ts` — `BlobStorageClient` interface, `BlobEntry`, `BlobTarget`, `resolveBlobTarget`, `createAzureBlobStorageClient` (real), `createFakeBlobStorageClient` (test double).
- **Create:** `steps/lib/blob-client.test.ts` — tests for `resolveBlobTarget` and `createFakeBlobStorageClient` (the real Azure-backed implementation is not directly unit tested, same as `trigger-adf-pipeline`'s `defaultDeps` — it's thin glue over the SDK).
- **Create:** `steps/remove-blob-files.ts` + `steps/remove-blob-files.test.ts`.
- **Create:** `steps/upload-to-blob.ts` + `steps/upload-to-blob.test.ts`.
- **Create:** `steps/verify-and-download-blob.ts` + `steps/verify-and-download-blob.test.ts`.
- **Create:** `configs/remove-blob-files.json`, `configs/upload-to-blob.json`, `configs/verify-and-download-blob.json`.
- **Modify:** `.pipelines/azure-pipelines.yml` — add SPN-env-var export (for `DefaultAzureCredential`) to the existing `AzureCLI@2` task, and three new step invocations.
- **Modify:** `README.md` — Layout/configs listings, `## Running` examples, a new `## Azure Blob Storage` section (mirroring `## Azure Key Vault`), and a one-line note about `steps/lib/` being the one exception to "every step is standalone."

---

### Task 1: Shared blob-client helper

**Files:**
- Create: `steps/lib/blob-client.ts`
- Create: `steps/lib/blob-client.test.ts`

**Interfaces:**
- Produces: `BlobEntry { name; lastModified?: Date; sizeBytes: number }`; `BlobStorageClient { listBlobs(containerName, prefix?): AsyncIterable<BlobEntry>; blobExists(containerName, blobPath): Promise<boolean>; deleteBlob(containerName, blobPath): Promise<void>; uploadBlob(containerName, blobPath, localFilePath, overwrite): Promise<{url, sizeBytes}>; downloadBlob(containerName, blobPath, localFilePath): Promise<{sizeBytes}> }`; `BlobTarget { accountUrl: string; containerName: string }`; `resolveBlobTarget(entry: {accountUrl?, containerName?}, config: {accountUrl?, containerName?}): BlobTarget` (throws if unresolvable); `createAzureBlobStorageClient(accountUrl: string): BlobStorageClient`; `createFakeBlobStorageClient(): BlobStorageClient & { seed(containerName, blobPath, content: Buffer): void }`.

- [ ] **Step 1: Install the new dependencies**

Run: `npm install @azure/storage-blob @azure/identity`
Expected: `package.json`'s `dependencies` field gains both packages; `package-lock.json` updates.

- [ ] **Step 2: Write the failing tests**

Create `steps/lib/blob-client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBlobTarget, createFakeBlobStorageClient } from './blob-client';

test('resolveBlobTarget uses per-entry fields when present', () => {
  const target = resolveBlobTarget(
    { accountUrl: 'https://a.blob.core.windows.net', containerName: 'c1' },
    {},
  );
  assert.deepEqual(target, { accountUrl: 'https://a.blob.core.windows.net', containerName: 'c1' });
});

test('resolveBlobTarget falls back to top-level config defaults', () => {
  const target = resolveBlobTarget(
    {},
    { accountUrl: 'https://a.blob.core.windows.net', containerName: 'c1' },
  );
  assert.deepEqual(target, { accountUrl: 'https://a.blob.core.windows.net', containerName: 'c1' });
});

test('resolveBlobTarget throws when a coordinate is missing everywhere', () => {
  assert.throws(
    () => resolveBlobTarget({ containerName: 'c1' }, {}),
    /accountUrl and containerName must be set/,
  );
});

test('listBlobs returns only seeded blobs matching the prefix', async () => {
  const client = createFakeBlobStorageClient();
  client.seed('c1', 'inbound/a.txt', Buffer.from('a'));
  client.seed('c1', 'inbound/b.txt', Buffer.from('b'));
  client.seed('c1', 'outbound/c.txt', Buffer.from('c'));

  const names: string[] = [];
  for await (const entry of client.listBlobs('c1', 'inbound/')) {
    names.push(entry.name);
  }
  assert.deepEqual(names.sort(), ['inbound/a.txt', 'inbound/b.txt']);
});

test('blobExists reflects seeded and unseeded blobs', async () => {
  const client = createFakeBlobStorageClient();
  client.seed('c1', 'a.txt', Buffer.from('a'));
  assert.equal(await client.blobExists('c1', 'a.txt'), true);
  assert.equal(await client.blobExists('c1', 'missing.txt'), false);
});

test('uploadBlob overwrites by default and rejects when overwrite is false and the blob exists', async () => {
  const client = createFakeBlobStorageClient();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-client-test-'));
  try {
    const localPath = path.join(tmpDir, 'input.txt');
    fs.writeFileSync(localPath, 'v1');
    const result1 = await client.uploadBlob('c1', 'a.txt', localPath, true);
    assert.equal(result1.sizeBytes, 2);

    fs.writeFileSync(localPath, 'v2-longer');
    const result2 = await client.uploadBlob('c1', 'a.txt', localPath, true);
    assert.equal(result2.sizeBytes, 9);

    await assert.rejects(
      () => client.uploadBlob('c1', 'a.txt', localPath, false),
      /already exists/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('downloadBlob writes the seeded content to a local file and throws for a missing blob', async () => {
  const client = createFakeBlobStorageClient();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-client-test-'));
  try {
    client.seed('c1', 'a.txt', Buffer.from('hello'));
    const localPath = path.join(tmpDir, 'out.txt');
    const result = await client.downloadBlob('c1', 'a.txt', localPath);
    assert.equal(result.sizeBytes, 5);
    assert.equal(fs.readFileSync(localPath, 'utf8'), 'hello');

    await assert.rejects(
      () => client.downloadBlob('c1', 'missing.txt', localPath),
      /not found/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('deleteBlob removes a seeded blob and is a no-op for a missing one', async () => {
  const client = createFakeBlobStorageClient();
  client.seed('c1', 'a.txt', Buffer.from('a'));
  await client.deleteBlob('c1', 'a.txt');
  assert.equal(await client.blobExists('c1', 'a.txt'), false);
  await client.deleteBlob('c1', 'missing.txt'); // does not throw
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test steps/lib/blob-client.test.ts`
Expected: FAIL — `steps/lib/blob-client.ts` doesn't exist yet (module not found).

- [ ] **Step 4: Write the implementation**

Create `steps/lib/blob-client.ts`:

```ts
/**
 * Shared Azure Blob Storage client helper for the blob-storage steps
 * (remove-blob-files, upload-to-blob, verify-and-download-blob).
 *
 * The one deliberate exception to this repo's "every step is a fully
 * standalone module" framing: three steps need identical
 * BlobServiceClient + DefaultAzureCredential setup, so it lives here once.
 *
 * createAzureBlobStorageClient() is the real implementation, used by each
 * step's default export. createFakeBlobStorageClient() is an in-memory
 * implementation of the same interface used by every step's tests — there
 * is no live Azure Storage account to test against in this environment.
 */

import * as fs from 'node:fs';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

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

// ---------- Target resolution ----------------------------------------------

export interface BlobTarget {
  accountUrl: string;
  containerName: string;
}

export function resolveBlobTarget(
  entry: { accountUrl?: string; containerName?: string },
  config: { accountUrl?: string; containerName?: string },
): BlobTarget {
  const accountUrl = entry.accountUrl ?? config.accountUrl;
  const containerName = entry.containerName ?? config.containerName;
  if (!accountUrl || !containerName) {
    throw new Error(
      'accountUrl and containerName must be set either per-entry or as top-level config defaults',
    );
  }
  return { accountUrl, containerName };
}

// ---------- Real Azure-backed implementation --------------------------------

export function createAzureBlobStorageClient(accountUrl: string): BlobStorageClient {
  const serviceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());

  return {
    async *listBlobs(containerName, prefix) {
      const containerClient = serviceClient.getContainerClient(containerName);
      for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        yield {
          name: blob.name,
          lastModified: blob.properties.lastModified,
          sizeBytes: blob.properties.contentLength ?? 0,
        };
      }
    },

    async blobExists(containerName, blobPath) {
      const blockBlobClient = serviceClient.getContainerClient(containerName).getBlockBlobClient(blobPath);
      return blockBlobClient.exists();
    },

    async deleteBlob(containerName, blobPath) {
      const blockBlobClient = serviceClient.getContainerClient(containerName).getBlockBlobClient(blobPath);
      await blockBlobClient.deleteIfExists();
    },

    async uploadBlob(containerName, blobPath, localFilePath, overwrite) {
      const blockBlobClient = serviceClient.getContainerClient(containerName).getBlockBlobClient(blobPath);
      try {
        await blockBlobClient.uploadFile(
          localFilePath,
          overwrite ? undefined : { conditions: { ifNoneMatch: '*' } },
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (!overwrite && statusCode === 409) {
          throw new Error(`Blob already exists: ${blobPath}`);
        }
        throw err;
      }
      const stats = fs.statSync(localFilePath);
      return { url: blockBlobClient.url, sizeBytes: stats.size };
    },

    async downloadBlob(containerName, blobPath, localFilePath) {
      const blockBlobClient = serviceClient.getContainerClient(containerName).getBlockBlobClient(blobPath);
      await blockBlobClient.downloadToFile(localFilePath);
      const stats = fs.statSync(localFilePath);
      return { sizeBytes: stats.size };
    },
  };
}

// ---------- Fake in-memory implementation (for tests) -----------------------

interface FakeBlobStorageClient extends BlobStorageClient {
  /** Test setup helper: seed a blob's content without going through uploadBlob. */
  seed(containerName: string, blobPath: string, content: Buffer): void;
}

export function createFakeBlobStorageClient(): FakeBlobStorageClient {
  const containers = new Map<string, Map<string, { content: Buffer; lastModified: Date }>>();

  function containerMap(containerName: string): Map<string, { content: Buffer; lastModified: Date }> {
    let map = containers.get(containerName);
    if (!map) {
      map = new Map();
      containers.set(containerName, map);
    }
    return map;
  }

  return {
    seed(containerName, blobPath, content) {
      containerMap(containerName).set(blobPath, { content, lastModified: new Date() });
    },

    async *listBlobs(containerName, prefix) {
      for (const [name, entry] of containerMap(containerName)) {
        if (!prefix || name.startsWith(prefix)) {
          yield { name, lastModified: entry.lastModified, sizeBytes: entry.content.length };
        }
      }
    },

    async blobExists(containerName, blobPath) {
      return containerMap(containerName).has(blobPath);
    },

    async deleteBlob(containerName, blobPath) {
      containerMap(containerName).delete(blobPath);
    },

    async uploadBlob(containerName, blobPath, localFilePath, overwrite) {
      const map = containerMap(containerName);
      if (!overwrite && map.has(blobPath)) {
        throw new Error(`Blob already exists: ${blobPath}`);
      }
      const content = fs.readFileSync(localFilePath);
      map.set(blobPath, { content, lastModified: new Date() });
      return { url: `fake://${containerName}/${blobPath}`, sizeBytes: content.length };
    },

    async downloadBlob(containerName, blobPath, localFilePath) {
      const entry = containerMap(containerName).get(blobPath);
      if (!entry) throw new Error(`Blob not found: ${blobPath}`);
      fs.writeFileSync(localFilePath, entry.content);
      return { sizeBytes: entry.content.length };
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test steps/lib/blob-client.test.ts`
Expected: PASS — 8 tests, 0 failures.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json steps/lib/blob-client.ts steps/lib/blob-client.test.ts
git commit -m "feat: add shared Azure Blob Storage client helper"
```

---

### Task 2: remove-blob-files step

**Files:**
- Create: `steps/remove-blob-files.ts`
- Create: `steps/remove-blob-files.test.ts`

**Interfaces:**
- Consumes: `BlobStorageClient`, `resolveBlobTarget`, `createAzureBlobStorageClient`, `createFakeBlobStorageClient` from Task 1's `./lib/blob-client`.
- Produces: `PatternEntry { name?, pattern, accountUrl?, containerName? }`; `RemoveBlobFilesConfig { accountUrl?, containerName?, patterns: PatternEntry[] }`; `globToRegExp(pattern: string): RegExp`; `literalPrefix(pattern: string): string`; `runAll(config, ctx, clientFactory?): Promise<StepResult>`; the module's `default` export.

- [ ] **Step 1: Write the failing tests**

Create `steps/remove-blob-files.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { globToRegExp, literalPrefix, runAll } from './remove-blob-files';
import { createFakeBlobStorageClient } from './lib/blob-client';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('globToRegExp: * matches within a path segment, ** matches across segments', () => {
  assert.equal(globToRegExp('inbound/*.csv').test('inbound/a.csv'), true);
  assert.equal(globToRegExp('inbound/*.csv').test('inbound/sub/a.csv'), false);
  assert.equal(globToRegExp('inbound/**/a.csv').test('inbound/x/y/a.csv'), true);
  assert.equal(globToRegExp('inbound/2026-*/*.gpg').test('inbound/2026-07-09/f.gpg'), true);
  assert.equal(globToRegExp('inbound/2026-*/*.gpg').test('inbound/2025-01-01/f.gpg'), false);
});

test('globToRegExp escapes regex-special characters literally', () => {
  assert.equal(globToRegExp('a.b+c').test('a.b+c'), true);
  assert.equal(globToRegExp('a.b+c').test('aXb+c'), false); // "." must be literal, not "any char"
});

test('literalPrefix returns the substring before the first wildcard', () => {
  assert.equal(literalPrefix('inbound/2026-*/*.gpg'), 'inbound/2026-');
  assert.equal(literalPrefix('inbound/exact.txt'), 'inbound/exact.txt');
  assert.equal(literalPrefix('*'), '');
});

test('runAll deletes only the blobs matching each pattern and reports counts', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmblob-test-'));
  try {
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'inbound/a.gpg', Buffer.from('a'));
    client.seed('c1', 'inbound/b.gpg', Buffer.from('b'));
    client.seed('c1', 'outbound/c.gpg', Buffer.from('c'));

    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      patterns: [{ name: 'cleanInbound', pattern: 'inbound/*.gpg' }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.totalPatterns, 1);
    assert.equal(result.outputs?.cleanInbound_matchedCount, 2);
    assert.equal(result.outputs?.cleanInbound_deletedCount, 2);
    assert.equal(await client.blobExists('c1', 'inbound/a.gpg'), false);
    assert.equal(await client.blobExists('c1', 'inbound/b.gpg'), false);
    assert.equal(await client.blobExists('c1', 'outbound/c.gpg'), true);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'delete-summary.json'), 'utf8'));
    assert.deepEqual(summary[0].deletedPaths.sort(), ['inbound/a.gpg', 'inbound/b.gpg']);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll reports zero matches without failing when a pattern matches nothing', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmblob-test-'));
  try {
    const client = createFakeBlobStorageClient();
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      patterns: [{ name: 'nothing', pattern: 'inbound/*.gpg' }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.nothing_matchedCount, 0);
    assert.equal(result.outputs?.nothing_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll processes multiple patterns concurrently; one failure does not block a sibling', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmblob-test-'));
  try {
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'ok/a.gpg', Buffer.from('a'));
    const config = {
      containerName: 'c1', // no top-level accountUrl default
      patterns: [
        { name: 'good', pattern: 'ok/*.gpg', accountUrl: 'https://acct.blob.core.windows.net' },
        { name: 'bad', pattern: '*.gpg' }, // no accountUrl anywhere -> resolveBlobTarget throws
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), () => client),
      /1\/2 pattern\(s\) failed to process[\s\S]*bad[\s\S]*Failed/,
    );
    assert.equal(await client.blobExists('c1', 'ok/a.gpg'), false);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws when config.patterns is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmblob-test-'));
  try {
    await assert.rejects(
      () => runAll({ patterns: [] }, fakeCtx(outDir), () => createFakeBlobStorageClient()),
      /config\.patterns must contain at least one pattern/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/remove-blob-files.test.ts`
Expected: FAIL — `steps/remove-blob-files.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `steps/remove-blob-files.ts`:

```ts
/**
 * Step: remove-blob-files (TypeScript)
 *
 * Deletes blobs matching one or more glob path patterns, e.g.
 * "inbound/2026-*/*.gpg". Pattern-based cleanup only — no age filtering.
 * Patterns are processed concurrently; the step waits for all patterns
 * before deciding pass/fail and throws one aggregated error if any
 * pattern's processing failed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import {
  createAzureBlobStorageClient,
  resolveBlobTarget,
  type BlobStorageClient,
} from './lib/blob-client';

export interface PatternEntry {
  /** Output key prefix for this pattern's results; defaults to "f{index}". */
  name?: string;
  pattern: string;
  accountUrl?: string;
  containerName?: string;
}

export interface RemoveBlobFilesConfig {
  accountUrl?: string;
  containerName?: string;
  patterns: PatternEntry[];
}

export interface PatternResult {
  name: string;
  pattern: string;
  matchedCount: number;
  deletedCount: number;
  deletedPaths: string[];
  status: 'Succeeded' | 'Failed';
  message?: string;
}

// ---------- Glob matching ---------------------------------------------------

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function literalPrefix(pattern: string): string {
  const idx = pattern.indexOf('*');
  return idx === -1 ? pattern : pattern.slice(0, idx);
}

// ---------- Per-pattern processing ------------------------------------------

async function runOnePattern(
  entry: PatternEntry,
  index: number,
  config: RemoveBlobFilesConfig,
  clientFactory: (accountUrl: string) => BlobStorageClient,
  ctx: StepContext,
): Promise<PatternResult> {
  const name = entry.name ?? `f${index}`;
  try {
    const target = resolveBlobTarget(entry, config);
    const client = clientFactory(target.accountUrl);
    const regex = globToRegExp(entry.pattern);
    const prefix = literalPrefix(entry.pattern);

    const matches: string[] = [];
    for await (const blob of client.listBlobs(target.containerName, prefix)) {
      if (regex.test(blob.name)) matches.push(blob.name);
    }

    ctx.log(`Pattern "${entry.pattern}" (${name}) matched ${matches.length} blob(s)`);

    await Promise.all(matches.map(blobPath => client.deleteBlob(target.containerName, blobPath)));

    return {
      name,
      pattern: entry.pattern,
      matchedCount: matches.length,
      deletedCount: matches.length,
      deletedPaths: matches,
      status: 'Succeeded',
    };
  } catch (err) {
    return {
      name,
      pattern: entry.pattern,
      matchedCount: 0,
      deletedCount: 0,
      deletedPaths: [],
      status: 'Failed',
      message: (err as Error).message,
    };
  }
}

// ---------- Orchestration ----------------------------------------------------

export async function runAll(
  config: RemoveBlobFilesConfig,
  ctx: StepContext,
  clientFactory: (accountUrl: string) => BlobStorageClient = createAzureBlobStorageClient,
): Promise<StepResult> {
  if (!config.patterns || config.patterns.length === 0) {
    throw new Error('config.patterns must contain at least one pattern');
  }

  const results = await Promise.all(
    config.patterns.map((entry, index) => runOnePattern(entry, index, config, clientFactory, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'delete-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status !== 'Succeeded');
  const outputs: Record<string, string | number | boolean> = {
    totalPatterns: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  for (const r of results) {
    outputs[`${r.name}_matchedCount`] = r.matchedCount;
    outputs[`${r.name}_deletedCount`] = r.deletedCount;
    outputs[`${r.name}_status`] = r.status;
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.pattern}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} pattern(s) failed to process:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<RemoveBlobFilesConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/remove-blob-files.test.ts`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/remove-blob-files.ts steps/remove-blob-files.test.ts
git commit -m "feat: add remove-blob-files step"
```

---

### Task 3: upload-to-blob step

**Files:**
- Create: `steps/upload-to-blob.ts`
- Create: `steps/upload-to-blob.test.ts`

**Interfaces:**
- Consumes: `BlobStorageClient`, `resolveBlobTarget`, `createAzureBlobStorageClient`, `createFakeBlobStorageClient` from Task 1's `./lib/blob-client`.
- Produces: `UploadEntry { name?, localPath, blobPath, overwrite?, accountUrl?, containerName? }`; `UploadToBlobConfig { accountUrl?, containerName?, files: UploadEntry[] }`; `runAll(config, ctx, clientFactory?): Promise<StepResult>`; the module's `default` export.

- [ ] **Step 1: Write the failing tests**

Create `steps/upload-to-blob.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './upload-to-blob';
import { createFakeBlobStorageClient } from './lib/blob-client';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('uploads a single named file and reports its blob path and size', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  try {
    const localPath = path.join(outDir, 'input.txt');
    fs.writeFileSync(localPath, 'hello');
    const client = createFakeBlobStorageClient();
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ name: 'payload', localPath, blobPath: 'inbound/payload.txt' }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.totalFiles, 1);
    assert.equal(result.outputs?.payload_blobPath, 'inbound/payload.txt');
    assert.equal(result.outputs?.payload_sizeBytes, 5);
    assert.equal(await client.blobExists('c1', 'inbound/payload.txt'), true);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('overwrites an existing blob by default', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  try {
    const localPath = path.join(outDir, 'input.txt');
    fs.writeFileSync(localPath, 'v2-longer');
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'inbound/payload.txt', Buffer.from('v1'));
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ localPath, blobPath: 'inbound/payload.txt' }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.f0_sizeBytes, 9);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails an entry when overwrite is false and the blob already exists', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  try {
    const localPath = path.join(outDir, 'input.txt');
    fs.writeFileSync(localPath, 'v2');
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'inbound/payload.txt', Buffer.from('v1'));
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ name: 'payload', localPath, blobPath: 'inbound/payload.txt', overwrite: false }],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), () => client),
      /1\/1 file\(s\) failed to upload[\s\S]*payload[\s\S]*already exists/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('uploads multiple files concurrently; one failure does not block the other', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  try {
    const goodPath = path.join(outDir, 'good.txt');
    fs.writeFileSync(goodPath, 'ok');
    const client = createFakeBlobStorageClient();
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [
        { name: 'good', localPath: goodPath, blobPath: 'inbound/good.txt' },
        { name: 'bad', localPath: path.join(outDir, 'missing.txt'), blobPath: 'inbound/bad.txt' },
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), () => client),
      /1\/2 file\(s\) failed to upload[\s\S]*bad[\s\S]*not found/,
    );
    assert.equal(await client.blobExists('c1', 'inbound/good.txt'), true);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  try {
    await assert.rejects(
      () => runAll({ files: [] }, fakeCtx(outDir), () => createFakeBlobStorageClient()),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/upload-to-blob.test.ts`
Expected: FAIL — `steps/upload-to-blob.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `steps/upload-to-blob.ts`:

```ts
/**
 * Step: upload-to-blob (TypeScript)
 *
 * Uploads one or more local files to Azure Blob Storage, e.g. encrypted
 * payloads from gpg-encrypt-file to an inbound container. Overwrites the
 * target blob by default; set overwrite: false to fail instead of
 * clobbering an existing blob. Files are processed concurrently; the step
 * waits for all files before deciding pass/fail and throws one aggregated
 * error if any file failed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import {
  createAzureBlobStorageClient,
  resolveBlobTarget,
  type BlobStorageClient,
} from './lib/blob-client';

export interface UploadEntry {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  localPath: string;
  blobPath: string;
  /** Overwrite an existing blob at blobPath; default true. */
  overwrite?: boolean;
  accountUrl?: string;
  containerName?: string;
}

export interface UploadToBlobConfig {
  accountUrl?: string;
  containerName?: string;
  files: UploadEntry[];
}

export interface UploadResult {
  name: string;
  blobPath: string;
  blobUrl?: string;
  sizeBytes: number;
  status: 'Succeeded' | 'Failed';
  message?: string;
}

async function runOneUpload(
  entry: UploadEntry,
  index: number,
  config: UploadToBlobConfig,
  clientFactory: (accountUrl: string) => BlobStorageClient,
  ctx: StepContext,
): Promise<UploadResult> {
  const name = entry.name ?? `f${index}`;
  try {
    if (!entry.localPath) throw new Error('localPath is required');
    if (!fs.existsSync(entry.localPath)) throw new Error(`Local file not found: ${entry.localPath}`);
    if (!entry.blobPath) throw new Error('blobPath is required');

    const target = resolveBlobTarget(entry, config);
    const client = clientFactory(target.accountUrl);
    const overwrite = entry.overwrite ?? true;

    const { url, sizeBytes } = await client.uploadBlob(target.containerName, entry.blobPath, entry.localPath, overwrite);
    ctx.log(`Uploaded "${entry.localPath}" -> "${entry.blobPath}" (${name})`);

    return { name, blobPath: entry.blobPath, blobUrl: url, sizeBytes, status: 'Succeeded' };
  } catch (err) {
    return {
      name,
      blobPath: entry.blobPath,
      sizeBytes: 0,
      status: 'Failed',
      message: (err as Error).message,
    };
  }
}

export async function runAll(
  config: UploadToBlobConfig,
  ctx: StepContext,
  clientFactory: (accountUrl: string) => BlobStorageClient = createAzureBlobStorageClient,
): Promise<StepResult> {
  if (!config.files || config.files.length === 0) {
    throw new Error('config.files must contain at least one file');
  }

  const results = await Promise.all(
    config.files.map((entry, index) => runOneUpload(entry, index, config, clientFactory, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'upload-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status !== 'Succeeded');
  const outputs: Record<string, string | number | boolean> = {
    totalFiles: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  for (const r of results) {
    outputs[`${r.name}_blobPath`] = r.blobPath;
    outputs[`${r.name}_blobUrl`] = r.blobUrl ?? '';
    outputs[`${r.name}_sizeBytes`] = r.sizeBytes;
    outputs[`${r.name}_status`] = r.status;
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.blobPath}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} file(s) failed to upload:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<UploadToBlobConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/upload-to-blob.test.ts`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/upload-to-blob.ts steps/upload-to-blob.test.ts
git commit -m "feat: add upload-to-blob step"
```

---

### Task 4: verify-and-download-blob step

**Files:**
- Create: `steps/verify-and-download-blob.ts`
- Create: `steps/verify-and-download-blob.test.ts`

**Interfaces:**
- Consumes: `BlobStorageClient`, `resolveBlobTarget`, `createAzureBlobStorageClient`, `createFakeBlobStorageClient` from Task 1's `./lib/blob-client`.
- Produces: `VerifyEntry { name?, blobPath, localPath?, required?, accountUrl?, containerName? }`; `VerifyAndDownloadConfig { accountUrl?, containerName?, files: VerifyEntry[] }`; `runAll(config, ctx, clientFactory?): Promise<StepResult>`; the module's `default` export.

- [ ] **Step 1: Write the failing tests**

Create `steps/verify-and-download-blob.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './verify-and-download-blob';
import { createFakeBlobStorageClient } from './lib/blob-client';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('downloads an existing blob to the default local path derived from its basename', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  try {
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'outbound/report.json', Buffer.from('{"ok":true}'));
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ name: 'report', blobPath: 'outbound/report.json' }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.report_exists, true);
    const localPath = result.outputs?.report_localPath as string;
    assert.equal(localPath, path.join(outDir, 'report.json'));
    assert.equal(fs.readFileSync(localPath, 'utf8'), '{"ok":true}');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails by default when a required blob is missing', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  try {
    const client = createFakeBlobStorageClient();
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ name: 'missing', blobPath: 'outbound/missing.json' }],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), () => client),
      /1\/1 file\(s\) failed verification[\s\S]*missing[\s\S]*not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('does not fail when a missing blob is marked required: false, and records exists: false', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  try {
    const client = createFakeBlobStorageClient();
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ name: 'optional', blobPath: 'outbound/optional.json', required: false }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.optional_exists, false);
    assert.equal(result.outputs?.optional_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('a missing required file does not block a sibling from downloading successfully', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  try {
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'outbound/present.json', Buffer.from('{"a":1}'));
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [
        { name: 'present', blobPath: 'outbound/present.json' },
        { name: 'missing', blobPath: 'outbound/missing.json' },
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), () => client),
      /1\/2 file\(s\) failed verification[\s\S]*missing/,
    );
    assert.ok(fs.existsSync(path.join(outDir, 'present.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  try {
    await assert.rejects(
      () => runAll({ files: [] }, fakeCtx(outDir), () => createFakeBlobStorageClient()),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/verify-and-download-blob.test.ts`
Expected: FAIL — `steps/verify-and-download-blob.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `steps/verify-and-download-blob.ts`:

```ts
/**
 * Step: verify-and-download-blob (TypeScript)
 *
 * Verifies that one or more expected blobs exist and downloads each one
 * that does. An entry whose blob is missing fails the step by default
 * (required: true); set required: false to record a miss without failing.
 * Files are processed concurrently; the step waits for all files before
 * deciding pass/fail and throws one aggregated error if any required file
 * was missing or failed to download.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import {
  createAzureBlobStorageClient,
  resolveBlobTarget,
  type BlobStorageClient,
} from './lib/blob-client';

export interface VerifyEntry {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  blobPath: string;
  /** Defaults to ctx.outDir/<basename of blobPath>. */
  localPath?: string;
  /** Fail the step if this blob is missing; default true. */
  required?: boolean;
  accountUrl?: string;
  containerName?: string;
}

export interface VerifyAndDownloadConfig {
  accountUrl?: string;
  containerName?: string;
  files: VerifyEntry[];
}

export interface VerifyResult {
  name: string;
  blobPath: string;
  exists: boolean;
  localPath?: string;
  sizeBytes: number;
  status: 'Succeeded' | 'Failed';
  message?: string;
}

async function runOneVerify(
  entry: VerifyEntry,
  index: number,
  config: VerifyAndDownloadConfig,
  clientFactory: (accountUrl: string) => BlobStorageClient,
  ctx: StepContext,
): Promise<VerifyResult> {
  const name = entry.name ?? `f${index}`;
  const required = entry.required ?? true;
  try {
    if (!entry.blobPath) throw new Error('blobPath is required');
    const target = resolveBlobTarget(entry, config);
    const client = clientFactory(target.accountUrl);

    const exists = await client.blobExists(target.containerName, entry.blobPath);
    if (!exists) {
      if (required) throw new Error(`Blob not found: ${entry.blobPath}`);
      return { name, blobPath: entry.blobPath, exists: false, sizeBytes: 0, status: 'Succeeded' };
    }

    const localPath = entry.localPath ?? path.join(ctx.outDir, path.basename(entry.blobPath));
    const { sizeBytes } = await client.downloadBlob(target.containerName, entry.blobPath, localPath);
    ctx.log(`Downloaded "${entry.blobPath}" (${name}) -> ${localPath}`);

    return { name, blobPath: entry.blobPath, exists: true, localPath, sizeBytes, status: 'Succeeded' };
  } catch (err) {
    return {
      name,
      blobPath: entry.blobPath,
      exists: false,
      sizeBytes: 0,
      status: 'Failed',
      message: (err as Error).message,
    };
  }
}

export async function runAll(
  config: VerifyAndDownloadConfig,
  ctx: StepContext,
  clientFactory: (accountUrl: string) => BlobStorageClient = createAzureBlobStorageClient,
): Promise<StepResult> {
  if (!config.files || config.files.length === 0) {
    throw new Error('config.files must contain at least one file');
  }

  const results = await Promise.all(
    config.files.map((entry, index) => runOneVerify(entry, index, config, clientFactory, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'verify-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status !== 'Succeeded');
  const outputs: Record<string, string | number | boolean> = {
    totalFiles: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  const artifacts: string[] = [];
  for (const r of results) {
    outputs[`${r.name}_exists`] = r.exists;
    outputs[`${r.name}_localPath`] = r.localPath ?? '';
    outputs[`${r.name}_sizeBytes`] = r.sizeBytes;
    outputs[`${r.name}_status`] = r.status;
    if (r.localPath) artifacts.push(r.localPath);
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.blobPath}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} file(s) failed verification:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath, ...artifacts] };
}

export default defineStep<VerifyAndDownloadConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/verify-and-download-blob.test.ts`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/verify-and-download-blob.ts steps/verify-and-download-blob.test.ts
git commit -m "feat: add verify-and-download-blob step"
```

---

### Task 5: Example configs, YAML wiring, and README

**Files:**
- Create: `configs/remove-blob-files.json`, `configs/upload-to-blob.json`, `configs/verify-and-download-blob.json`
- Modify: `.pipelines/azure-pipelines.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `RemoveBlobFilesConfig` (Task 2), `UploadToBlobConfig` (Task 3), `VerifyAndDownloadConfig` (Task 4).

- [ ] **Step 1: Create the three example configs**

Create `configs/remove-blob-files.json`:

```json
{
  "accountUrl": "https://mystorageaccount.blob.core.windows.net",
  "containerName": "inbound",
  "patterns": [
    { "name": "oldPayloads", "pattern": "payloads/*.gpg" }
  ]
}
```

Create `configs/upload-to-blob.json`:

```json
{
  "accountUrl": "https://mystorageaccount.blob.core.windows.net",
  "containerName": "inbound",
  "files": [
    {
      "name": "usersCsvGpg",
      "localPath": "{{steps.gpgEncryptCsv.outputs.usersCsvGpg_encryptedPath}}",
      "blobPath": "payloads/users.csv.gpg"
    }
  ]
}
```

Create `configs/verify-and-download-blob.json`:

```json
{
  "accountUrl": "https://mystorageaccount.blob.core.windows.net",
  "containerName": "outbound",
  "files": [
    { "name": "result", "blobPath": "results/users-result.json" }
  ]
}
```

- [ ] **Step 2: Wire DefaultAzureCredential auth and the three new steps into the YAML**

In `.pipelines/azure-pipelines.yml`, the existing `AzureCLI@2` task (around line 39-47, "Fetch ADF access token") also needs to export the service principal's credentials as environment variables, since `DefaultAzureCredential` (used by the blob steps) falls back to `EnvironmentCredential`, which reads `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID`. Update that task to:

```yaml
          # ---- Fetch an ARM access token for the ADF management API,
          # and export SPN credentials for DefaultAzureCredential -------
          - task: AzureCLI@2
            displayName: 'Fetch ADF access token and export SPN credentials'
            inputs:
              azureSubscription: 'my-service-connection'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              addSpnToEnvironment: true
              inlineScript: |
                TOKEN=$(az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv)
                echo "##vso[task.setvariable variable=adfAccessToken;issecret=true]$TOKEN"
                echo "##vso[task.setvariable variable=azureClientId;issecret=true]$servicePrincipalId"
                echo "##vso[task.setvariable variable=azureClientSecret;issecret=true]$servicePrincipalKey"
                echo "##vso[task.setvariable variable=azureTenantId;issecret=true]$tenantId"
```

Then add two new steps to the `Generate` stage's `build_data` job — a `remove-blob-files` cleanup before upload, and the `upload-to-blob` step itself — placed after the `gpgEncryptCsv` step and before the `triggerAdf` step:

```yaml
          # ---- Step: clean up old inbound payloads before uploading ---
          - script: >
              npx tsx runner/run-step.ts
              --step steps/remove-blob-files.ts
              --config configs/remove-blob-files.json
              --name cleanupInbound
            name: cleanupInbound
            displayName: 'Remove old inbound blob payloads'
            env:
              AZURE_CLIENT_ID: $(azureClientId)
              AZURE_CLIENT_SECRET: $(azureClientSecret)
              AZURE_TENANT_ID: $(azureTenantId)

          # ---- Step: upload the encrypted payload to inbound storage --
          - script: >
              npx tsx runner/run-step.ts
              --step steps/upload-to-blob.ts
              --config configs/upload-to-blob.json
              --name uploadPayload
            name: uploadPayload
            displayName: 'Upload encrypted payload to inbound blob storage'
            env:
              AZURE_CLIENT_ID: $(azureClientId)
              AZURE_CLIENT_SECRET: $(azureClientSecret)
              AZURE_TENANT_ID: $(azureTenantId)
```

Finally, add a `verify-and-download-blob` step to the `Deliver` stage's `ship_data` job (after the existing `download: current` step), representing verifying/downloading an outbound result file:

```yaml
          # ---- Step: verify + download the outbound result file -------
          - script: >
              npx tsx runner/run-step.ts
              --step steps/verify-and-download-blob.ts
              --config configs/verify-and-download-blob.json
              --name verifyResult
            name: verifyResult
            displayName: 'Verify and download outbound result'
            env:
              AZURE_CLIENT_ID: $(azureClientId)
              AZURE_CLIENT_SECRET: $(azureClientSecret)
              AZURE_TENANT_ID: $(azureTenantId)
```

Note: `azureClientId`/`azureClientSecret`/`azureTenantId` are set in the `Generate` stage's job and are not automatically available in the separate `Deliver` stage/job (pipeline variables set via `task.setvariable` don't cross stage boundaries the way stage `outputs` do). This YAML is illustrative/example — like the rest of this file (`'my-service-connection'`, `'my-keyvault'` are placeholders) — so leave a comment noting that a real pipeline would need its own `AzureCLI@2` (`addSpnToEnvironment: true`) task in the `Deliver` stage to re-export these for `verifyResult`, rather than duplicating the full task here.

- [ ] **Step 3: Update README.md**

Update the `Layout` section's `steps/` listing to add:

```
  lib/
    blob-client.ts             # shared Azure Blob Storage client (real + fake, used by the 3 steps below)
  remove-blob-files.ts        # delete blobs matching a glob path pattern
  upload-to-blob.ts           # upload local file(s) to blob storage
  verify-and-download-blob.ts # verify expected blob(s) exist and download them
```

And the `configs/` listing to add:

```
  remove-blob-files.json
  upload-to-blob.json
  verify-and-download-blob.json
```

Add a one-line note right after the `## The step contract (typed)` section's existing paragraph (after "...fail `npm run typecheck`."):

```markdown
The one exception to "every step is standalone": the three blob-storage
steps share `steps/lib/blob-client.ts` for Azure auth/client setup, since
duplicating it three times bought nothing.
```

Add a new runnable example to the `## Running` section, after the existing `trigger-adf-pipeline` example:

```markdown
Blob storage steps (need `DefaultAzureCredential` to resolve — e.g.
`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` env vars, or `az
login` locally):

\`\`\`bash
npx tsx runner/run-step.ts \
  --step steps/remove-blob-files.ts \
  --config configs/remove-blob-files.json \
  --name cleanupInbound

npx tsx runner/run-step.ts \
  --step steps/upload-to-blob.ts \
  --config configs/upload-to-blob.json \
  --name uploadPayload

npx tsx runner/run-step.ts \
  --step steps/verify-and-download-blob.ts \
  --config configs/verify-and-download-blob.json \
  --name verifyResult
\`\`\`
```

Add a new `## Azure Blob Storage` section after the existing `## Azure Key Vault` section:

```markdown
## Azure Blob Storage

`remove-blob-files`, `upload-to-blob`, and `verify-and-download-blob` all
authenticate via `DefaultAzureCredential` against an `accountUrl` — no
connection string or SAS token. In Azure Pipelines, export the service
connection's SPN as environment variables via `AzureCLI@2`'s
`addSpnToEnvironment: true` (see `.pipelines/azure-pipelines.yml`) and map
`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` into each blob
step's `env`; `DefaultAzureCredential`'s `EnvironmentCredential` fallback
picks these up automatically. Locally, `az login` is enough (via
`DefaultAzureCredential`'s `AzureCliCredential` fallback).
```

- [ ] **Step 4: Verify the new configs parse and the full suite still passes**

Run:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/remove-blob-files.json', 'utf8')))"
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/upload-to-blob.json', 'utf8')))"
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/verify-and-download-blob.json', 'utf8')))"
npm test
npm run typecheck
```
Expected: all three `node -e` calls print the parsed object with no error; `npm test` shows all tests passing (Task 1: 8, Task 2: 7, Task 3: 5, Task 4: 5 — 25 new, plus the 24 already in the repo from Group A/trigger-adf-pipeline — 49 total); `npm run typecheck` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add configs/remove-blob-files.json configs/upload-to-blob.json configs/verify-and-download-blob.json .pipelines/azure-pipelines.yml README.md
git commit -m "docs: wire blob storage steps into pipeline YAML and README"
```
