# Multi-File generate-synthetic-csv and gpg-encrypt-file Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `generate-synthetic-csv` and `gpg-encrypt-file` from single-file-per-invocation to multi-file-per-invocation, each file independently configured, so a downstream "generate payload" step can produce/encrypt several distinct files in one step call.

**Architecture:** Both steps move their config from a flat single-file shape to `{ files: FileConfig[] }`. Each step extracts its existing single-file logic into a `generateOneFile`/`encryptOneFile` helper function, then the `run()` body becomes a sequential `for` loop over `config.files` that calls that helper, flattens each result into name-prefixed `StepResult.outputs` keys, and fails fast (throws immediately, naming the failing entry) on the first error. This is a breaking config-shape change — no dual-shape backward compatibility — so the example configs and the YAML's `Deliver` stage variable reference are updated in the same change.

**Tech Stack:** TypeScript, `tsx --test` / `node:test` / `node:assert/strict` (same as `trigger-adf-pipeline`'s test setup). The GPG step's tests exercise the real `gpg` CLI end-to-end (generate an ephemeral test keypair once via `gpg --batch --passphrase '' --quick-gen-key`, encrypt through the step, decrypt with the test key, assert round-trip content) — this mirrors the step's own reliance on the real `gpg` binary and was verified to run in ~0.4s per keypair in this environment.

## Global Constraints

- No new npm dependencies.
- `npm run typecheck` (tsc --noEmit) must pass after every task that touches `.ts` files.
- This is a breaking change to both steps' config shape — no dual-shape (old flat config vs new `files` array) backward compatibility path. All existing consumers (example configs, YAML) are updated in this plan, not left on the old shape.
- Both steps process `config.files` **sequentially** (plain `for` loop) and **fail-fast** (throw immediately on the first entry's error, naming that entry's index and `name` in the message) — no `Promise.all`, no wait-for-all-then-aggregate (unlike `trigger-adf-pipeline`).
- Output keys are flattened and prefixed by each entry's `name` (or `f{index}` if `name` is omitted), plus a `totalFiles` count — same naming convention as `trigger-adf-pipeline`'s `p{index}` pattern.
- Test command: `npx tsx --test steps/generate-synthetic-csv.test.ts` and `npx tsx --test steps/gpg-encrypt-file.test.ts` (or `npm test`, which globs all `steps/**/*.test.ts`).

---

## File Structure

- **Modify:** `steps/generate-synthetic-csv.ts` — config types, extract `generateOneFile`, sequential loop with fail-fast, collision-safe default `fileName` (`synthetic-{index}.csv` instead of a fixed literal, since multiple entries can now omit `fileName`).
- **Create:** `steps/generate-synthetic-csv.test.ts` — unit tests using real temp dirs.
- **Modify:** `steps/gpg-encrypt-file.ts` — config types, extract `encryptOneFile` (each entry gets its own ephemeral keyring, since different entries can use different keys), sequential loop with fail-fast, explicit collision detection on `outputFileName` across entries in the same batch (throws rather than silently overwriting).
- **Create:** `steps/gpg-encrypt-file.test.ts` — unit tests exercising the real `gpg` CLI against an ephemeral test keypair.
- **Modify:** `configs/generate-users-csv.json` — wrap in `{ "files": [...] }`, single entry, explicit `name: "usersCsv"`.
- **Modify:** `configs/gpg-encrypt-users-csv.json` — wrap in `{ "files": [...] }`, single entry, explicit `name: "usersCsvGpg"`, update its `inputPath` reference to the new prefixed output key.
- **Modify:** `.pipelines/azure-pipelines.yml` — update the `Deliver` stage's `encryptedFile` variable to the new prefixed output key.
- **Modify:** `README.md` — update the `## How outputs flow` section's config-interpolation example and pipeline-variable example to the new prefixed keys, and add a naming-convention note (matching the existing `trigger-adf-pipeline` note in the same section).

---

### Task 1: Multi-file generate-synthetic-csv

**Files:**
- Modify: `steps/generate-synthetic-csv.ts`
- Create: `steps/generate-synthetic-csv.test.ts`

**Interfaces:**
- Produces: `FileConfig` (per-file config: `name?`, `fileName?`, `rowCount?`, `seed?`, `columns`), `GenerateCsvConfig { files: FileConfig[] }` (replaces the old flat shape). `ColumnConfig` is unchanged. The default export's `run(config, ctx)` throws `"config.files must contain at least one file"` if `files` is missing/empty, and `` `File entry {index} ("{name}") failed: {message}` `` on the first entry that fails. `StepResult.outputs` contains `totalFiles` plus, per entry, `{name}_csvPath`, `{name}_fileName`, `{name}_rowCount`, `{name}_columnNames`, `{name}_seed`, `{name}_sizeBytes`. `StepResult.artifacts` is the list of all successfully written file paths.

- [ ] **Step 1: Write the failing tests**

Create `steps/generate-synthetic-csv.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import step from './generate-synthetic-csv';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return {
    stepName: 'test',
    outDir,
    workspace: outDir,
    steps: {},
    log: () => {},
    warn: () => {},
  };
}

test('generates a single named file with the requested row count', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  try {
    const config = {
      files: [
        {
          name: 'usersCsv',
          fileName: 'users.csv',
          rowCount: 5,
          seed: 1,
          columns: [{ name: 'id', type: 'uuid' as const }],
        },
      ],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.totalFiles, 1);
    assert.equal(result.outputs?.usersCsv_fileName, 'users.csv');
    assert.equal(result.outputs?.usersCsv_rowCount, 5);
    const filePath = result.outputs?.usersCsv_csvPath as string;
    assert.ok(fs.existsSync(filePath));
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 6); // header + 5 rows
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('generates multiple files with distinct default names and no path collisions', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  try {
    const config = {
      files: [
        { rowCount: 2, seed: 1, columns: [{ name: 'id', type: 'uuid' as const }] },
        { rowCount: 3, seed: 2, columns: [{ name: 'id', type: 'uuid' as const }] },
      ],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.totalFiles, 2);
    assert.equal(result.outputs?.f0_fileName, 'synthetic-0.csv');
    assert.equal(result.outputs?.f1_fileName, 'synthetic-1.csv');
    assert.notEqual(result.outputs?.f0_csvPath, result.outputs?.f1_csvPath);
    const rows0 = fs.readFileSync(result.outputs?.f0_csvPath as string, 'utf8').trim().split('\n');
    const rows1 = fs.readFileSync(result.outputs?.f1_csvPath as string, 'utf8').trim().split('\n');
    assert.equal(rows0.length, 3); // header + 2 rows
    assert.equal(rows1.length, 4); // header + 3 rows
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast on the first invalid entry, naming it in the error, after writing prior entries', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  try {
    const config = {
      files: [
        { name: 'good', rowCount: 1, seed: 1, columns: [{ name: 'id', type: 'uuid' as const }] },
        { name: 'bad', rowCount: 1, columns: [] },
      ],
    };
    await assert.rejects(
      () => step.run(config, fakeCtx(outDir)),
      /File entry 1 \("bad"\) failed:.*columns/,
    );
    assert.ok(fs.readdirSync(outDir).includes('synthetic-0.csv'));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  try {
    await assert.rejects(
      () => step.run({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/generate-synthetic-csv.test.ts`
Expected: FAIL — the current step still exports a flat `GenerateCsvConfig` (`{ fileName?, rowCount?, seed?, columns }`), not `{ files: [...] }`, so calling `step.run({ files: [...] }, ctx)` will not error at the type level (config is untyped `unknown` at the JS boundary) but will fail at runtime: `config.columns` is `undefined`, so the current code throws `'config.columns must define at least one column'` — a different message than the new tests expect, and `result.outputs?.totalFiles` etc. will all be `undefined`, failing the assertions.

- [ ] **Step 3: Rewrite the implementation**

Replace the full contents of `steps/generate-synthetic-csv.ts` with:

```ts
/**
 * Step: generate-synthetic-csv (TypeScript)
 *
 * Generates one or more mock CSV payloads from declarative column configs.
 * Column types are a discriminated union, so tsc catches invalid column
 * configs (e.g. "values" on an int column) at compile time when configs are
 * authored in TS; JSON configs are validated at runtime.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext } from '../runner/types';

// ---------- Config types -------------------------------------------------

interface BaseColumn {
  name: string;
  /** 0..1 chance of emitting an empty cell, for sparse data. */
  nullProbability?: number;
}

export type ColumnConfig =
  | (BaseColumn & { type: 'uuid' })
  | (BaseColumn & { type: 'firstName' | 'lastName' | 'fullName' | 'email' })
  | (BaseColumn & { type: 'int'; min?: number; max?: number })
  | (BaseColumn & { type: 'float'; min?: number; max?: number; decimals?: number })
  | (BaseColumn & { type: 'bool'; trueProbability?: number })
  | (BaseColumn & { type: 'date'; from?: string; to?: string; format?: 'iso' | 'date' })
  | (BaseColumn & { type: 'enum'; values: string[] })
  | (BaseColumn & { type: 'template'; template: string })
  | (BaseColumn & { type: 'constant'; value: string | number | boolean });

export interface FileConfig {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  fileName?: string;
  rowCount?: number | string; // string when overridden via STEP_CONFIG_ env
  seed?: number | string;
  columns: ColumnConfig[];
}

export interface GenerateCsvConfig {
  files: FileConfig[];
}

// ---------- Deterministic RNG (mulberry32) -------------------------------

type Rng = () => number;

function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = ['Alice', 'Bob', 'Carla', 'Dev', 'Elena', 'Farid', 'Grace', 'Hiro', 'Ines', 'Jack', 'Kim', 'Luca', 'Mei', 'Noah', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Umar'];
const LAST_NAMES = ['Nguyen', 'Smith', 'Garcia', 'Kaur', 'Chen', 'Okafor', 'Rossi', 'Tanaka', 'Brown', 'Silva', 'Kowalski', 'Ali', 'Martin', 'Ivanov', 'Lee', 'Papadopoulos'];
const DOMAINS = ['example.com', 'test.io', 'mock.dev', 'sample.org'];

const pick = <T,>(rng: Rng, arr: T[]): T => arr[Math.floor(rng() * arr.length)];

function generateValue(rng: Rng, col: ColumnConfig, rowIndex: number): string | number | boolean {
  switch (col.type) {
    case 'uuid':
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.floor(rng() * 16);
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    case 'firstName': return pick(rng, FIRST_NAMES);
    case 'lastName': return pick(rng, LAST_NAMES);
    case 'fullName': return `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    case 'email':
      return `${pick(rng, FIRST_NAMES).toLowerCase()}.${pick(rng, LAST_NAMES).toLowerCase()}${Math.floor(rng() * 1000)}@${pick(rng, DOMAINS)}`;
    case 'int': {
      const min = col.min ?? 0;
      const max = col.max ?? 100;
      return Math.floor(rng() * (max - min + 1)) + min;
    }
    case 'float': {
      const min = col.min ?? 0;
      const max = col.max ?? 1;
      return (rng() * (max - min) + min).toFixed(col.decimals ?? 2);
    }
    case 'bool': return rng() < (col.trueProbability ?? 0.5);
    case 'date': {
      const from = new Date(col.from ?? '2000-01-01').getTime();
      const to = new Date(col.to ?? Date.now()).getTime();
      const d = new Date(from + rng() * (to - from));
      return col.format === 'date' ? d.toISOString().slice(0, 10) : d.toISOString();
    }
    case 'enum': return pick(rng, col.values);
    case 'template': return col.template.replace('{rowIndex}', String(rowIndex));
    case 'constant': return col.value;
    default: {
      const never: never = col;
      throw new Error(`Unknown column type: ${JSON.stringify(never)}`);
    }
  }
}

function csvEscape(value: string | number | boolean | null): string {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- Per-file generation --------------------------------------------

interface OneFileResult {
  fileName: string;
  filePath: string;
  rowCount: number;
  seed: number;
  columnNames: string;
  sizeBytes: number;
}

function generateOneFile(file: FileConfig, index: number, ctx: StepContext): OneFileResult {
  const rowCount = Number(file.rowCount ?? 100);
  const columns = file.columns ?? [];
  if (!columns.length) throw new Error('columns must define at least one column');

  const seed = Number(file.seed ?? Date.now());
  const rng = makeRng(seed);
  const fileName = file.fileName ?? `synthetic-${index}.csv`;
  const filePath = path.join(ctx.outDir, fileName);

  ctx.log(`Generating ${rowCount} rows, ${columns.length} columns, seed=${seed} -> ${fileName}`);

  const lines: string[] = [columns.map(c => csvEscape(c.name)).join(',')];
  for (let i = 0; i < rowCount; i++) {
    const row = columns.map(col => {
      if (col.nullProbability && rng() < col.nullProbability) return '';
      return csvEscape(generateValue(rng, col, i));
    });
    lines.push(row.join(','));
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  const stats = fs.statSync(filePath);

  return {
    fileName,
    filePath,
    rowCount,
    seed,
    columnNames: columns.map(c => c.name).join(','),
    sizeBytes: stats.size,
  };
}

// ---------- Step ------------------------------------------------------------

export default defineStep<GenerateCsvConfig>({
  async run(config, ctx) {
    if (!config.files || config.files.length === 0) {
      throw new Error('config.files must contain at least one file');
    }

    const outputs: Record<string, string | number | boolean> = {
      totalFiles: config.files.length,
    };
    const artifacts: string[] = [];

    for (let index = 0; index < config.files.length; index++) {
      const file = config.files[index];
      const name = file.name ?? `f${index}`;
      let result: OneFileResult;
      try {
        result = generateOneFile(file, index, ctx);
      } catch (err) {
        throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
      }
      outputs[`${name}_csvPath`] = result.filePath;
      outputs[`${name}_fileName`] = result.fileName;
      outputs[`${name}_rowCount`] = result.rowCount;
      outputs[`${name}_columnNames`] = result.columnNames;
      outputs[`${name}_seed`] = result.seed;
      outputs[`${name}_sizeBytes`] = result.sizeBytes;
      artifacts.push(result.filePath);
    }

    return { outputs, artifacts };
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/generate-synthetic-csv.test.ts`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (This will also surface any other file in the repo that still imports the old flat `GenerateCsvConfig` shape — none currently do at the `.ts` level, since `configs/generate-users-csv.json` is loaded at runtime as untyped JSON, not imported as a TS type.)

- [ ] **Step 6: Commit**

```bash
git add steps/generate-synthetic-csv.ts steps/generate-synthetic-csv.test.ts
git commit -m "feat: support multiple files per generate-synthetic-csv invocation"
```

---

### Task 2: Multi-file gpg-encrypt-file

**Files:**
- Modify: `steps/gpg-encrypt-file.ts`
- Create: `steps/gpg-encrypt-file.test.ts`

**Interfaces:**
- Produces: `FileEntryConfig` (per-file config: `name?`, `inputPath`, `publicKeyArmored?`, `keyVaultUrl?`, `secretName?`, `recipient?`, `outputFileName?`, `armor?`, `cipherAlgo?`), `GpgEncryptConfig { files: FileEntryConfig[] }` (replaces the old flat shape). The default export's `run(config, ctx)` throws `"config.files must contain at least one file"` if `files` is missing/empty, and `` `File entry {index} ("{name}") failed: {message}` `` on the first entry that fails — including when an entry's `outputFileName` (explicit or defaulted from its `inputPath` basename) collides with an earlier entry's in the same batch. `StepResult.outputs` contains `totalFiles` plus, per entry, `{name}_encryptedPath`, `{name}_fileName`, `{name}_recipient`, `{name}_sizeBytes`, `{name}_sourceFile`. `StepResult.artifacts` is the list of all successfully written encrypted file paths.

- [ ] **Step 1: Write the failing tests**

Create `steps/gpg-encrypt-file.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import step from './gpg-encrypt-file';
import type { StepContext } from '../runner/types';

let testGnupgHome: string;
let publicKeyA: string;
let publicKeyB: string;

function genTestKey(gnupgHome: string, uid: string): string {
  execFileSync(
    'gpg',
    ['--batch', '--passphrase', '', '--quick-gen-key', uid, 'default', 'default', 'never'],
    { env: { ...process.env, GNUPGHOME: gnupgHome } },
  );
  return execFileSync('gpg', ['--armor', '--export', uid], {
    env: { ...process.env, GNUPGHOME: gnupgHome },
    encoding: 'utf8',
  });
}

function decryptWithTestKey(encryptedPath: string): string {
  return execFileSync(
    'gpg',
    ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', '', '--decrypt', encryptedPath],
    { env: { ...process.env, GNUPGHOME: testGnupgHome }, encoding: 'utf8' },
  );
}

function fakeCtx(outDir: string): StepContext {
  return {
    stepName: 'test',
    outDir,
    workspace: outDir,
    steps: {},
    log: () => {},
    warn: () => {},
  };
}

before(() => {
  testGnupgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gnupg-test-'));
  fs.chmodSync(testGnupgHome, 0o700);
  publicKeyA = genTestKey(testGnupgHome, 'Test A <a@example.com>');
  publicKeyB = genTestKey(testGnupgHome, 'Test B <b@example.com>');
});

after(() => {
  fs.rmSync(testGnupgHome, { recursive: true, force: true });
});

test('encrypts a single named file and round-trips through decrypt', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
  try {
    const inputPath = path.join(outDir, 'input.txt');
    fs.writeFileSync(inputPath, 'hello from file A\n');
    const config = {
      files: [{ name: 'fileA', inputPath, publicKeyArmored: publicKeyA, outputFileName: 'a.gpg' }],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.totalFiles, 1);
    assert.equal(result.outputs?.fileA_fileName, 'a.gpg');
    const encryptedPath = result.outputs?.fileA_encryptedPath as string;
    assert.ok(fs.existsSync(encryptedPath));
    assert.equal(decryptWithTestKey(encryptedPath), 'hello from file A\n');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('encrypts multiple files with different keys and distinct output names', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
  try {
    const inputA = path.join(outDir, 'a.txt');
    const inputB = path.join(outDir, 'b.txt');
    fs.writeFileSync(inputA, 'payload A\n');
    fs.writeFileSync(inputB, 'payload B\n');
    const config = {
      files: [
        { name: 'outA', inputPath: inputA, publicKeyArmored: publicKeyA, outputFileName: 'a.gpg' },
        { name: 'outB', inputPath: inputB, publicKeyArmored: publicKeyB, outputFileName: 'b.gpg' },
      ],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.totalFiles, 2);
    assert.notEqual(result.outputs?.outA_encryptedPath, result.outputs?.outB_encryptedPath);
    assert.equal(decryptWithTestKey(result.outputs?.outA_encryptedPath as string), 'payload A\n');
    assert.equal(decryptWithTestKey(result.outputs?.outB_encryptedPath as string), 'payload B\n');
    assert.notEqual(result.outputs?.outA_recipient, result.outputs?.outB_recipient);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when two entries default or specify the same output filename', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
  try {
    const inputA = path.join(outDir, 'a.txt');
    const inputB = path.join(outDir, 'b.txt');
    fs.writeFileSync(inputA, 'payload A\n');
    fs.writeFileSync(inputB, 'payload B\n');
    const config = {
      files: [
        { name: 'outA', inputPath: inputA, publicKeyArmored: publicKeyA, outputFileName: 'same.gpg' },
        { name: 'outB', inputPath: inputB, publicKeyArmored: publicKeyB, outputFileName: 'same.gpg' },
      ],
    };
    await assert.rejects(
      () => step.run(config, fakeCtx(outDir)),
      /File entry 1 \("outB"\) failed:.*same\.gpg.*already used/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast when an input file is missing, naming the entry', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
  try {
    const config = {
      files: [{ name: 'missing', inputPath: path.join(outDir, 'nope.txt'), publicKeyArmored: publicKeyA }],
    };
    await assert.rejects(
      () => step.run(config, fakeCtx(outDir)),
      /File entry 0 \("missing"\) failed:.*Input file not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
  try {
    await assert.rejects(
      () => step.run({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/gpg-encrypt-file.test.ts`
Expected: FAIL. The current step's `run()` reads `config.inputPath` directly (there is no `config.files`), so `config.inputPath` is `undefined` and the step throws `'config.inputPath is required'` — different from what the new tests expect (`result.outputs?.totalFiles` etc. are all `undefined`, and the fail-fast tests' regexes don't match the old error message shape).

- [ ] **Step 3: Rewrite the implementation**

Replace the full contents of `steps/gpg-encrypt-file.ts` with:

```ts
/**
 * Step: gpg-encrypt-file (TypeScript)
 *
 * Encrypts one or more files, each with its own GPG public key, sourced
 * from Azure Key Vault.
 * Route A (recommended): AzureKeyVault@2 task -> pipeline variable ->
 *   env mapping -> "publicKeyArmored": "{{env.GPG_PUBLIC_KEY}}"
 * Route B: "keyVaultUrl" + "secretName" -> fetched via
 *   @azure/identity + @azure/keyvault-secrets (optional deps).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defineStep, type StepContext } from '../runner/types';

export interface FileEntryConfig {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  /** File to encrypt, usually {{steps.<name>.outputs.<key>_csvPath}}. */
  inputPath: string;
  /** ASCII-armored public key, usually {{env.GPG_PUBLIC_KEY}}. */
  publicKeyArmored?: string;
  /** Alternative: fetch the key from Key Vault via SDK. */
  keyVaultUrl?: string;
  secretName?: string;
  /** Recipient override; defaults to the imported key's fingerprint. */
  recipient?: string;
  outputFileName?: string;
  /** ASCII-armored output (.asc) instead of binary (.gpg). */
  armor?: boolean;
  /** e.g. "AES256" */
  cipherAlgo?: string;
}

export interface GpgEncryptConfig {
  files: FileEntryConfig[];
}

function gpg(gnupgHome: string, args: string[]): string {
  return execFileSync('gpg', ['--batch', '--yes', ...args], {
    env: { ...process.env, GNUPGHOME: gnupgHome },
    encoding: 'utf8',
  });
}

async function fetchKeyFromVault(keyVaultUrl: string, secretName: string, ctx: StepContext): Promise<string> {
  ctx.log(`Fetching secret "${secretName}" from ${keyVaultUrl} via SDK`);
  // Imported via variable specifiers so tsc doesn't require these optional
  // deps to be installed; they're only needed if this route is used.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let identity: any;
  let secrets: any;
  try {
    const [identityPkg, secretsPkg] = ['@azure/identity', '@azure/keyvault-secrets'];
    identity = await import(identityPkg);
    secrets = await import(secretsPkg);
  } catch {
    throw new Error(
      'keyVaultUrl was set but @azure/identity / @azure/keyvault-secrets are not installed. ' +
      'Either `npm i @azure/identity @azure/keyvault-secrets`, or use the AzureKeyVault@2 ' +
      'task and pass the key via publicKeyArmored instead.',
    );
  }
  const client = new secrets.SecretClient(keyVaultUrl, new identity.DefaultAzureCredential());
  const secret = await client.getSecret(secretName);
  if (!secret.value) throw new Error(`Secret "${secretName}" has no value`);
  return secret.value;
}

// ---------- Per-file encryption --------------------------------------------

interface OneFileResult {
  fileName: string;
  filePath: string;
  recipient: string;
  sizeBytes: number;
  sourceFile: string;
}

async function encryptOneFile(
  file: FileEntryConfig,
  ctx: StepContext,
  usedOutputNames: Set<string>,
): Promise<OneFileResult> {
  if (!file.inputPath) throw new Error('inputPath is required');
  if (!fs.existsSync(file.inputPath)) throw new Error(`Input file not found: ${file.inputPath}`);

  const inputName = path.basename(file.inputPath);
  const outputFileName = file.outputFileName ?? `${inputName}${file.armor ? '.asc' : '.gpg'}`;
  if (usedOutputNames.has(outputFileName)) {
    throw new Error(
      `Output filename "${outputFileName}" is already used by an earlier file entry in this batch. ` +
      'Set an explicit, distinct outputFileName for each entry.',
    );
  }
  usedOutputNames.add(outputFileName);

  // --- Resolve the public key -------------------------------------
  let publicKey = file.publicKeyArmored;
  if (!publicKey && file.keyVaultUrl && file.secretName) {
    publicKey = await fetchKeyFromVault(file.keyVaultUrl, file.secretName, ctx);
  }
  if (!publicKey || !publicKey.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
    throw new Error(
      'No usable GPG public key. Provide publicKeyArmored (ASCII-armored) ' +
      'or keyVaultUrl + secretName. If the key arrived via a pipeline ' +
      'variable, check the secret was actually mapped into the step env.',
    );
  }
  // Restore newlines if the key was flattened to a single line with \n escapes.
  if (!publicKey.includes('\n')) publicKey = publicKey.replace(/\\n/g, '\n');

  // --- Import into an ephemeral keyring, scoped to this file entry ---
  const gnupgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gnupg-'));
  fs.chmodSync(gnupgHome, 0o700);
  try {
    const keyPath = path.join(gnupgHome, 'pub.asc');
    fs.writeFileSync(keyPath, publicKey, { mode: 0o600 });
    gpg(gnupgHome, ['--import', keyPath]);

    let recipient = file.recipient;
    if (!recipient) {
      const listing = gpg(gnupgHome, ['--list-keys', '--with-colons']);
      const fprLine = listing.split('\n').find(l => l.startsWith('fpr:'));
      if (!fprLine) throw new Error('Could not determine fingerprint of imported key');
      recipient = fprLine.split(':')[9];
    }
    ctx.log(`Encrypting for recipient ${recipient}`);

    // --- Encrypt ---------------------------------------------------
    const outputPath = path.join(ctx.outDir, outputFileName);

    const args = [
      '--trust-model', 'always', // ephemeral keyring; key provenance is Key Vault
      '--recipient', recipient,
      '--output', outputPath,
    ];
    if (file.armor) args.push('--armor');
    if (file.cipherAlgo) args.push('--cipher-algo', file.cipherAlgo);
    args.push('--encrypt', file.inputPath);
    gpg(gnupgHome, args);

    const stats = fs.statSync(outputPath);
    ctx.log(`Wrote ${outputPath} (${stats.size} bytes)`);

    return {
      fileName: outputFileName,
      filePath: outputPath,
      recipient,
      sizeBytes: stats.size,
      sourceFile: file.inputPath,
    };
  } finally {
    fs.rmSync(gnupgHome, { recursive: true, force: true });
  }
}

// ---------- Step ------------------------------------------------------------

export default defineStep<GpgEncryptConfig>({
  async run(config, ctx) {
    if (!config.files || config.files.length === 0) {
      throw new Error('config.files must contain at least one file');
    }

    const outputs: Record<string, string | number | boolean> = {
      totalFiles: config.files.length,
    };
    const artifacts: string[] = [];
    const usedOutputNames = new Set<string>();

    for (let index = 0; index < config.files.length; index++) {
      const file = config.files[index];
      const name = file.name ?? `f${index}`;
      let result: OneFileResult;
      try {
        result = await encryptOneFile(file, ctx, usedOutputNames);
      } catch (err) {
        throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
      }
      outputs[`${name}_encryptedPath`] = result.filePath;
      outputs[`${name}_fileName`] = result.fileName;
      outputs[`${name}_recipient`] = result.recipient;
      outputs[`${name}_sizeBytes`] = result.sizeBytes;
      outputs[`${name}_sourceFile`] = result.sourceFile;
      artifacts.push(result.filePath);
    }

    return { outputs, artifacts };
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/gpg-encrypt-file.test.ts`
Expected: PASS — 5 tests, 0 failures. (Requires `gpg` on PATH; already a runtime dependency of this step.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/gpg-encrypt-file.ts steps/gpg-encrypt-file.test.ts
git commit -m "feat: support multiple files with independent keys per gpg-encrypt-file invocation"
```

---

### Task 3: Update example configs, YAML, and README for the new config shape

**Files:**
- Modify: `configs/generate-users-csv.json`
- Modify: `configs/gpg-encrypt-users-csv.json`
- Modify: `.pipelines/azure-pipelines.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `GenerateCsvConfig`/`FileConfig` from Task 1 and `GpgEncryptConfig`/`FileEntryConfig` from Task 2 — this task only updates JSON/YAML/Markdown content to match those shapes, no `.ts` changes.

- [ ] **Step 1: Update the CSV example config**

Replace the full contents of `configs/generate-users-csv.json` with:

```json
{
  "files": [
    {
      "name": "usersCsv",
      "fileName": "users.csv",
      "rowCount": 250,
      "seed": 42,
      "columns": [
        { "name": "id", "type": "uuid" },
        { "name": "firstName", "type": "firstName" },
        { "name": "lastName", "type": "lastName" },
        { "name": "email", "type": "email" },
        { "name": "age", "type": "int", "min": 18, "max": 90 },
        { "name": "balance", "type": "float", "min": 0, "max": 10000, "decimals": 2 },
        { "name": "signupAt", "type": "date", "from": "2020-01-01", "to": "2026-01-01" },
        { "name": "plan", "type": "enum", "values": ["free", "pro", "enterprise"] },
        { "name": "active", "type": "bool", "trueProbability": 0.8 },
        { "name": "referrer", "type": "template", "template": "campaign-{rowIndex}", "nullProbability": 0.3 }
      ]
    }
  ]
}
```

- [ ] **Step 2: Update the GPG example config**

Replace the full contents of `configs/gpg-encrypt-users-csv.json` with:

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

- [ ] **Step 3: Update the YAML's Deliver-stage variable reference**

In `.pipelines/azure-pipelines.yml`, the `Deliver` stage's `variables` block currently reads:

```yaml
    variables:
      encryptedFile: $[ stageDependencies.Generate.build_data.outputs['gpgEncryptCsv.gpgEncryptCsv.encryptedPath'] ]
```

Change it to:

```yaml
    variables:
      encryptedFile: $[ stageDependencies.Generate.build_data.outputs['gpgEncryptCsv.gpgEncryptCsv.usersCsvGpg_encryptedPath'] ]
```

No other part of the YAML changes — the `script` invocations for `genUsersCsv` and `gpgEncryptCsv` call the same CLI with the same `--config` file paths; only those files' contents changed shape.

- [ ] **Step 4: Update README's "How outputs flow" section**

In `README.md`, the `## How outputs flow` section currently reads (numbered list items 1 and 2):

```markdown
1. **Config interpolation** — `"inputPath": "{{steps.genUsersCsv.outputs.csvPath}}"`
   resolved from the upstream `output.json`; `{{env.VAR}}` also works.
2. **Pipeline output variables** — every output is emitted via
   `##vso[task.setvariable …;isOutput=true]`; read as
   `$(genUsersCsv.genUsersCsv.rowCount)` or via `stageDependencies`. For
   `trigger-adf-pipeline`, each pipeline run's outputs are prefixed by its
   configured `name` (or `p0`, `p1`, … by index), e.g.
   `$(triggerAdf.triggerAdf.copyOrders_status)`.
```

Replace with:

```markdown
1. **Config interpolation** — `"inputPath": "{{steps.genUsersCsv.outputs.usersCsv_csvPath}}"`
   resolved from the upstream `output.json`; `{{env.VAR}}` also works.
2. **Pipeline output variables** — every output is emitted via
   `##vso[task.setvariable …;isOutput=true]`; read as
   `$(genUsersCsv.genUsersCsv.usersCsv_rowCount)` or via
   `stageDependencies`. `generate-synthetic-csv`, `gpg-encrypt-file`, and
   `trigger-adf-pipeline` all support multiple items per invocation, and
   all three flatten each item's outputs under a prefix — that item's
   configured `name` (or `f0`, `f1`, … / `p0`, `p1`, … by index if `name`
   is omitted), e.g. `$(triggerAdf.triggerAdf.copyOrders_status)`.
```

- [ ] **Step 5: Verify the example configs parse and the full suite still passes**

Run:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/generate-users-csv.json', 'utf8')))"
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/gpg-encrypt-users-csv.json', 'utf8')))"
npm test
npm run typecheck
```
Expected: both `node -e` calls print the parsed object with no error; `npm test` shows all tests passing (Tasks 1 and 2's new tests plus the existing `trigger-adf-pipeline` tests, 24 total); `npm run typecheck` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add configs/generate-users-csv.json configs/gpg-encrypt-users-csv.json .pipelines/azure-pipelines.yml README.md
git commit -m "docs: update example configs, YAML, and README for multi-file config shape"
```
