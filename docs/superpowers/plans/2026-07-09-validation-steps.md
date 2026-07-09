# Payload Validation Steps (Group C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three storage-agnostic pipeline steps — `verify-row-count`, `validate-json-schema`, `validate-business-logic` — for validating local payload files, backed by a shared `steps/lib/csv.ts` parser.

**Architecture:** A new shared module `steps/lib/csv.ts` (the second exception to "every step is standalone," after `steps/lib/blob-client.ts`) exports a small RFC4180-style `parseCsv` function used by two of the three steps. All three steps follow Group A's local-file convention exactly: `defineStep` wraps an exported `runAll(config, ctx)` that processes `config.files` **sequentially** with a plain `for` loop and **fails fast**, throwing `` File entry {index} ("{name}") failed: {message} `` on the first entry that fails — never concurrent, never wait-for-all (that's Group B's network-I/O convention, which doesn't apply here). Every step's `run()` and `runAll()` are synchronous functions (no `await` needed anywhere — file reads, CSV parsing, JSON parsing, and ajv validation are all synchronous), which is a legitimate simplification over Group A's steps (which were `async` for no functional reason); `defineStep`'s contract accepts `Promise<StepResult> | StepResult`, so a plain synchronous return is valid.

**Tech Stack:** TypeScript, `ajv` ^8.20.0 (new dependency — confirmed current version and API shape via a local smoke test: `new Ajv({ allErrors: true })`, `.compile(schema)`, `validate(data)` returns boolean, `validate.errors` is an array of `{ instancePath, message }`), `tsx --test` / `node:test` / `node:assert/strict`.

## Global Constraints

- New dependency: `ajv` (added via `npm install`, not hand-edited into package.json).
- `npm run typecheck` (tsc --noEmit) must pass after every task that touches `.ts` files.
- All three steps process `config.files` **sequentially** (plain `for` loop) and **fail-fast**, throwing immediately on the first entry's error with the exact format `` File entry {index} ("{name}") failed: {message} `` — matching Group A's convention verbatim.
- Output keys are flattened, prefixed by each entry's `name` (or `f{index}` if omitted), plus a `totalFiles` count.
- None of these three steps talk to Azure or any external system — pure local file I/O.
- `validate-business-logic` collects **every** rule violation for a failing entry (not just the first) before throwing — this is orthogonal to the fail-fast-across-entries model; only the within-one-entry rule checking is exhaustive.
- Test command: `npm test` (globs `steps/**/*.test.ts`, quoted correctly as of the Group B final review fix — confirmed picks up nested `steps/lib/*.test.ts`).

---

## File Structure

- **Create:** `steps/lib/csv.ts` — `parseCsv(content: string): ParsedCsv`.
- **Create:** `steps/lib/csv.test.ts`.
- **Create:** `steps/verify-row-count.ts` + `steps/verify-row-count.test.ts`.
- **Create:** `steps/validate-json-schema.ts` + `steps/validate-json-schema.test.ts`.
- **Create:** `steps/validate-business-logic.ts` + `steps/validate-business-logic.test.ts`.
- **Create:** `configs/verify-row-count.json`, `configs/validate-json-schema.json`, `configs/validate-business-logic.json`, `configs/schemas/outbound-result-schema.json`.
- **Modify:** `.pipelines/azure-pipelines.yml` — add three new step invocations to the `Deliver` stage's `ship_data` job, after `verifyResult`.
- **Modify:** `README.md` — Layout/configs listings, the "standalone module" exception note (now covering two shared libs), `## Running` examples, a new `## Payload Validation` section.

---

### Task 1: Shared CSV parser

**Files:**
- Create: `steps/lib/csv.ts`
- Create: `steps/lib/csv.test.ts`

**Interfaces:**
- Produces: `ParsedCsv { headers: string[]; rows: Record<string, string>[] }`; `parseCsv(content: string): ParsedCsv`.

- [ ] **Step 1: Write the failing tests**

Create `steps/lib/csv.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './csv';

test('parses a simple csv into headers and row objects', () => {
  const result = parseCsv('id,name\n1,Alice\n2,Bob\n');
  assert.deepEqual(result.headers, ['id', 'name']);
  assert.deepEqual(result.rows, [
    { id: '1', name: 'Alice' },
    { id: '2', name: 'Bob' },
  ]);
});

test('handles a quoted field containing a comma', () => {
  const result = parseCsv('id,name\n1,"Bob, Jr"\n');
  assert.deepEqual(result.rows, [{ id: '1', name: 'Bob, Jr' }]);
});

test('handles a quoted field containing an embedded newline as one row, not two', () => {
  const result = parseCsv('id,note\n1,"line1\nline2"\n2,ok\n');
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], { id: '1', note: 'line1\nline2' });
  assert.deepEqual(result.rows[1], { id: '2', note: 'ok' });
});

test('handles an escaped double-quote inside a quoted field', () => {
  const result = parseCsv('id,quote\n1,"she said ""hi"""\n');
  assert.deepEqual(result.rows, [{ id: '1', quote: 'she said "hi"' }]);
});

test('handles content with no trailing newline', () => {
  const result = parseCsv('id,name\n1,Alice');
  assert.deepEqual(result.rows, [{ id: '1', name: 'Alice' }]);
});

test('returns empty headers and rows for empty content', () => {
  const result = parseCsv('');
  assert.deepEqual(result, { headers: [], rows: [] });
});

test('returns empty rows for a header-only file', () => {
  const result = parseCsv('id,name\n');
  assert.deepEqual(result.headers, ['id', 'name']);
  assert.deepEqual(result.rows, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/lib/csv.test.ts`
Expected: FAIL — `steps/lib/csv.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write the implementation**

Create `steps/lib/csv.ts`:

```ts
/**
 * Shared CSV parser for the payload validation steps (verify-row-count,
 * validate-business-logic). A small RFC4180-style state machine — plain
 * newline-splitting would miscount rows if a field contains an embedded
 * newline, which generate-synthetic-csv's own csvEscape can produce.
 */

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(content: string): ParsedCsv {
  const rawRows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const c = content[i];

    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rawRows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush a trailing field/row for content that doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rawRows.push(row);
  }

  const [headers, ...dataRows] = rawRows;
  if (!headers) return { headers: [], rows: [] };

  return {
    headers,
    rows: dataRows.map(r => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? '']))),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/lib/csv.test.ts`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/lib/csv.ts steps/lib/csv.test.ts
git commit -m "feat: add shared CSV parser for payload validation steps"
```

---

### Task 2: verify-row-count step

**Files:**
- Create: `steps/verify-row-count.ts`
- Create: `steps/verify-row-count.test.ts`

**Interfaces:**
- Consumes: `parseCsv` from Task 1's `./lib/csv`.
- Produces: `RowCountEntry { name?, filePath, format?: 'csv'|'json', minRows?, maxRows? }`; `VerifyRowCountConfig { files: RowCountEntry[] }`; `runAll(config, ctx): StepResult`; the module's `default` export.

- [ ] **Step 1: Write the failing tests**

Create `steps/verify-row-count.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './verify-row-count';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('counts CSV rows excluding the header and passes when within range', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    const csvPath = path.join(outDir, 'data.csv');
    fs.writeFileSync(csvPath, 'id,name\n1,Alice\n2,Bob\n3,Carla\n');
    const config = { files: [{ name: 'data', filePath: csvPath, minRows: 2, maxRows: 5 }] };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.data_rowCount, 3);
    assert.equal(result.outputs?.data_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('counts a JSON top-level array by length', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    const jsonPath = path.join(outDir, 'data.json');
    fs.writeFileSync(jsonPath, JSON.stringify([{ a: 1 }, { a: 2 }]));
    const config = { files: [{ name: 'data', filePath: jsonPath }] };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.data_rowCount, 2);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails an entry whose row count is below minRows', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    const csvPath = path.join(outDir, 'data.csv');
    fs.writeFileSync(csvPath, 'id\n1\n');
    const config = { files: [{ name: 'tooFew', filePath: csvPath, minRows: 5 }] };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("tooFew"\) failed:.*below minRows/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails an entry whose row count is above maxRows', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    const csvPath = path.join(outDir, 'data.csv');
    fs.writeFileSync(csvPath, 'id\n1\n2\n3\n');
    const config = { files: [{ name: 'tooMany', filePath: csvPath, maxRows: 1 }] };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("tooMany"\) failed:.*above maxRows/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast on the first invalid entry without checking the rest', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    const badPath = path.join(outDir, 'missing.csv');
    const goodPath = path.join(outDir, 'good.csv');
    fs.writeFileSync(goodPath, 'id\n1\n');
    const config = {
      files: [
        { name: 'bad', filePath: badPath },
        { name: 'good', filePath: goodPath },
      ],
    };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("bad"\) failed:.*not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    assert.throws(
      () => runAll({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/verify-row-count.test.ts`
Expected: FAIL — `steps/verify-row-count.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `steps/verify-row-count.ts`:

```ts
/**
 * Step: verify-row-count (TypeScript)
 *
 * Verifies one or more files' row/entry counts fall within a min/max
 * range. CSV files are parsed with the shared parser (excludes the
 * header row); JSON files must have a top-level array, counted by
 * length. Files are processed sequentially; the step fails fast on the
 * first entry outside its configured range.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import { parseCsv } from './lib/csv';

export interface RowCountEntry {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  filePath: string;
  /** Defaults from the file extension (.csv -> csv, .json -> json). */
  format?: 'csv' | 'json';
  minRows?: number;
  maxRows?: number;
}

export interface VerifyRowCountConfig {
  files: RowCountEntry[];
}

function inferFormat(filePath: string): 'csv' | 'json' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.json') return 'json';
  throw new Error(`Cannot infer format from extension "${ext}"; set format explicitly`);
}

function countRows(filePath: string, format: 'csv' | 'json'): number {
  const content = fs.readFileSync(filePath, 'utf8');
  if (format === 'csv') {
    return parseCsv(content).rows.length;
  }
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error(`JSON file's top-level value is not an array: ${filePath}`);
  }
  return parsed.length;
}

function checkOneFile(entry: RowCountEntry): { rowCount: number } {
  if (!entry.filePath) throw new Error('filePath is required');
  if (!fs.existsSync(entry.filePath)) throw new Error(`File not found: ${entry.filePath}`);

  const format = entry.format ?? inferFormat(entry.filePath);
  const rowCount = countRows(entry.filePath, format);

  if (entry.minRows !== undefined && rowCount < entry.minRows) {
    throw new Error(`rowCount ${rowCount} is below minRows ${entry.minRows}`);
  }
  if (entry.maxRows !== undefined && rowCount > entry.maxRows) {
    throw new Error(`rowCount ${rowCount} is above maxRows ${entry.maxRows}`);
  }

  return { rowCount };
}

export function runAll(config: VerifyRowCountConfig, ctx: StepContext): StepResult {
  if (!config.files || config.files.length === 0) {
    throw new Error('config.files must contain at least one file');
  }

  const outputs: Record<string, string | number | boolean> = {
    totalFiles: config.files.length,
  };

  for (let index = 0; index < config.files.length; index++) {
    const entry = config.files[index];
    const name = entry.name ?? `f${index}`;
    let result: { rowCount: number };
    try {
      result = checkOneFile(entry);
    } catch (err) {
      throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
    }
    ctx.log(`"${entry.filePath}" (${name}) has ${result.rowCount} row(s)`);
    outputs[`${name}_rowCount`] = result.rowCount;
    outputs[`${name}_status`] = 'Succeeded';
  }

  return { outputs };
}

export default defineStep<VerifyRowCountConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/verify-row-count.test.ts`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/verify-row-count.ts steps/verify-row-count.test.ts
git commit -m "feat: add verify-row-count step"
```

---

### Task 3: validate-json-schema step

**Files:**
- Create: `steps/validate-json-schema.ts`
- Create: `steps/validate-json-schema.test.ts`

**Interfaces:**
- Produces: `SchemaEntry { name?, filePath, schemaPath }`; `ValidateJsonSchemaConfig { files: SchemaEntry[] }`; `runAll(config, ctx): StepResult`; the module's `default` export.

- [ ] **Step 1: Install the new dependency**

Run: `npm install ajv`
Expected: `package.json`'s `dependencies` gains `ajv`; `package-lock.json` updates.

- [ ] **Step 2: Write the failing tests**

Create `steps/validate-json-schema.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './validate-json-schema';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

const USER_SCHEMA = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0 },
  },
};

test('validates a conforming JSON file successfully', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    const dataPath = path.join(outDir, 'data.json');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    fs.writeFileSync(dataPath, JSON.stringify({ id: '1', name: 'Alice', age: 30 }));
    const config = { files: [{ name: 'user', filePath: dataPath, schemaPath }] };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.user_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails with every validation error listed when a required field is missing and a type is wrong', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    const dataPath = path.join(outDir, 'data.json');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    fs.writeFileSync(dataPath, JSON.stringify({ name: 'Alice', age: 'thirty' }));
    const config = { files: [{ name: 'user', filePath: dataPath, schemaPath }] };
    assert.throws(() => runAll(config, fakeCtx(outDir)), (err: Error) => {
      assert.match(err.message, /File entry 0 \("user"\) failed:/);
      assert.match(err.message, /required/);
      assert.match(err.message, /age/);
      return true;
    });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast on the first invalid entry without checking the rest', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    const badPath = path.join(outDir, 'bad.json');
    fs.writeFileSync(badPath, JSON.stringify({ age: 5 }));
    const goodPath = path.join(outDir, 'good.json');
    fs.writeFileSync(goodPath, JSON.stringify({ id: '1', name: 'Bob' }));
    const config = {
      files: [
        { name: 'bad', filePath: badPath, schemaPath },
        { name: 'good', filePath: goodPath, schemaPath },
      ],
    };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("bad"\) failed:/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when the data file is missing', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    const config = { files: [{ name: 'missing', filePath: path.join(outDir, 'nope.json'), schemaPath }] };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("missing"\) failed:.*not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    assert.throws(
      () => runAll({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test steps/validate-json-schema.test.ts`
Expected: FAIL — `steps/validate-json-schema.ts` doesn't exist yet.

- [ ] **Step 4: Write the implementation**

Create `steps/validate-json-schema.ts`:

```ts
/**
 * Step: validate-json-schema (TypeScript)
 *
 * Validates one or more JSON files against a caller-supplied JSON Schema
 * (draft-07, via ajv's default export). Files are processed sequentially;
 * the step fails fast on the first entry that doesn't validate, with
 * every ajv validation error included in the failure message.
 */

import * as fs from 'node:fs';
import Ajv from 'ajv';
import { defineStep, type StepContext, type StepResult } from '../runner/types';

export interface SchemaEntry {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  filePath: string;
  schemaPath: string;
}

export interface ValidateJsonSchemaConfig {
  files: SchemaEntry[];
}

function validateOneFile(entry: SchemaEntry): void {
  if (!entry.filePath) throw new Error('filePath is required');
  if (!entry.schemaPath) throw new Error('schemaPath is required');
  if (!fs.existsSync(entry.filePath)) throw new Error(`File not found: ${entry.filePath}`);
  if (!fs.existsSync(entry.schemaPath)) throw new Error(`Schema not found: ${entry.schemaPath}`);

  const schema = JSON.parse(fs.readFileSync(entry.schemaPath, 'utf8'));
  const data = JSON.parse(fs.readFileSync(entry.filePath, 'utf8'));

  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    const detail = (validate.errors ?? [])
      .map(e => `  - ${e.instancePath || '(root)'}: ${e.message}`)
      .join('\n');
    throw new Error(`Schema validation failed:\n${detail}`);
  }
}

export function runAll(config: ValidateJsonSchemaConfig, ctx: StepContext): StepResult {
  if (!config.files || config.files.length === 0) {
    throw new Error('config.files must contain at least one file');
  }

  const outputs: Record<string, string | number | boolean> = {
    totalFiles: config.files.length,
  };

  for (let index = 0; index < config.files.length; index++) {
    const entry = config.files[index];
    const name = entry.name ?? `f${index}`;
    try {
      validateOneFile(entry);
    } catch (err) {
      throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
    }
    ctx.log(`"${entry.filePath}" (${name}) validated against "${entry.schemaPath}"`);
    outputs[`${name}_status`] = 'Succeeded';
  }

  return { outputs };
}

export default defineStep<ValidateJsonSchemaConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test steps/validate-json-schema.test.ts`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json steps/validate-json-schema.ts steps/validate-json-schema.test.ts
git commit -m "feat: add validate-json-schema step"
```

---

### Task 4: validate-business-logic step

**Files:**
- Create: `steps/validate-business-logic.ts`
- Create: `steps/validate-business-logic.test.ts`

**Interfaces:**
- Consumes: `parseCsv` from Task 1's `./lib/csv`.
- Produces: `Rule` (discriminated union: `rowCountMatches`, `allCsvRowsHaveJsonMatch`, `allJsonEntriesHaveCsvMatch`, `fieldsEqual`); `BusinessLogicEntry { name?, csvPath, jsonPath, csvKeyField, jsonKeyField, rules: Rule[] }`; `ValidateBusinessLogicConfig { files: BusinessLogicEntry[] }`; `runAll(config, ctx): StepResult`; the module's `default` export.

- [ ] **Step 1: Write the failing tests**

Create `steps/validate-business-logic.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './validate-business-logic';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('passes when row counts match, all keys correlate, and fields are equal', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    const csvPath = path.join(outDir, 'inbound.csv');
    const jsonPath = path.join(outDir, 'outbound.json');
    fs.writeFileSync(csvPath, 'id,amount\n1,100\n2,200\n');
    fs.writeFileSync(jsonPath, JSON.stringify([
      { recordId: '1', total: '100' },
      { recordId: '2', total: '200' },
    ]));
    const config = {
      files: [{
        name: 'payload',
        csvPath,
        jsonPath,
        csvKeyField: 'id',
        jsonKeyField: 'recordId',
        rules: [
          { type: 'rowCountMatches' },
          { type: 'allCsvRowsHaveJsonMatch' },
          { type: 'allJsonEntriesHaveCsvMatch' },
          { type: 'fieldsEqual', csvField: 'amount', jsonField: 'total' },
        ],
      }],
    };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.payload_status, 'Succeeded');
    assert.equal(result.outputs?.payload_rulesChecked, 4);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('collects every rule violation for one entry, not just the first', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    const csvPath = path.join(outDir, 'inbound.csv');
    const jsonPath = path.join(outDir, 'outbound.json');
    fs.writeFileSync(csvPath, 'id,amount\n1,100\n2,200\n3,300\n');
    fs.writeFileSync(jsonPath, JSON.stringify([
      { recordId: '1', total: '999' }, // wrong amount
      { recordId: '2', total: '200' },
      // recordId 3 missing entirely, and only 2 json entries vs 3 csv rows
    ]));
    const config = {
      files: [{
        name: 'payload',
        csvPath,
        jsonPath,
        csvKeyField: 'id',
        jsonKeyField: 'recordId',
        rules: [
          { type: 'rowCountMatches' },
          { type: 'allCsvRowsHaveJsonMatch' },
          { type: 'fieldsEqual', csvField: 'amount', jsonField: 'total' },
        ],
      }],
    };
    assert.throws(() => runAll(config, fakeCtx(outDir)), (err: Error) => {
      assert.match(err.message, /File entry 0 \("payload"\) failed:/);
      assert.match(err.message, /rowCountMatches/);
      assert.match(err.message, /allCsvRowsHaveJsonMatch/);
      assert.match(err.message, /fieldsEqual/);
      return true;
    });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('rowCountMatches respects tolerance', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    const csvPath = path.join(outDir, 'inbound.csv');
    const jsonPath = path.join(outDir, 'outbound.json');
    fs.writeFileSync(csvPath, 'id\n1\n2\n3\n');
    fs.writeFileSync(jsonPath, JSON.stringify([{ recordId: '1' }, { recordId: '2' }]));
    const config = {
      files: [{
        name: 'payload',
        csvPath,
        jsonPath,
        csvKeyField: 'id',
        jsonKeyField: 'recordId',
        rules: [{ type: 'rowCountMatches', tolerance: 1 }],
      }],
    };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.payload_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast on the first invalid entry without checking the rest', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    const badCsvPath = path.join(outDir, 'bad.csv');
    const goodCsvPath = path.join(outDir, 'good.csv');
    const jsonPath = path.join(outDir, 'data.json');
    fs.writeFileSync(badCsvPath, 'id\n1\n2\n'); // 2 rows
    fs.writeFileSync(goodCsvPath, 'id\n1\n'); // 1 row
    fs.writeFileSync(jsonPath, JSON.stringify([{ recordId: '1' }])); // 1 entry
    const config = {
      files: [
        {
          name: 'bad',
          csvPath: badCsvPath,
          jsonPath,
          csvKeyField: 'id',
          jsonKeyField: 'recordId',
          rules: [{ type: 'rowCountMatches' }], // 2 vs 1 -> violation
        },
        {
          name: 'good',
          csvPath: goodCsvPath,
          jsonPath,
          csvKeyField: 'id',
          jsonKeyField: 'recordId',
          rules: [{ type: 'rowCountMatches' }], // 1 vs 1 -> ok
        },
      ],
    };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("bad"\) failed:/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails when the csv file is missing', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    const jsonPath = path.join(outDir, 'data.json');
    fs.writeFileSync(jsonPath, JSON.stringify([{ recordId: '1' }]));
    const config = {
      files: [{
        name: 'missing',
        csvPath: path.join(outDir, 'nope.csv'),
        jsonPath,
        csvKeyField: 'id',
        jsonKeyField: 'recordId',
        rules: [{ type: 'rowCountMatches' }],
      }],
    };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("missing"\) failed:.*not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    assert.throws(
      () => runAll({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/validate-business-logic.test.ts`
Expected: FAIL — `steps/validate-business-logic.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `steps/validate-business-logic.ts`:

```ts
/**
 * Step: validate-business-logic (TypeScript)
 *
 * Checks declarative cross-file rules between a CSV and a JSON file (e.g.
 * an inbound payload CSV against an outbound JSON result), correlating
 * rows/entries by a key field on each side. Files are processed
 * sequentially; for each entry every configured rule is checked (not just
 * the first violation), and the step fails fast on the first entry with
 * any violation.
 */

import * as fs from 'node:fs';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import { parseCsv } from './lib/csv';

export type Rule =
  | { type: 'rowCountMatches'; tolerance?: number }
  | { type: 'allCsvRowsHaveJsonMatch' }
  | { type: 'allJsonEntriesHaveCsvMatch' }
  | { type: 'fieldsEqual'; csvField: string; jsonField: string };

export interface BusinessLogicEntry {
  /** Output key prefix for this entry's results; defaults to "f{index}". */
  name?: string;
  csvPath: string;
  jsonPath: string;
  csvKeyField: string;
  jsonKeyField: string;
  rules: Rule[];
}

export interface ValidateBusinessLogicConfig {
  files: BusinessLogicEntry[];
}

function checkRule(
  rule: Rule,
  csvRows: Record<string, string>[],
  jsonEntries: Record<string, unknown>[],
  csvByKey: Map<string, Record<string, string>>,
  jsonByKey: Map<string, Record<string, unknown>>,
): string[] {
  const violations: string[] = [];

  switch (rule.type) {
    case 'rowCountMatches': {
      const diff = Math.abs(csvRows.length - jsonEntries.length);
      if (diff > (rule.tolerance ?? 0)) {
        violations.push(
          `rowCountMatches: csv has ${csvRows.length} row(s), json has ${jsonEntries.length} entr(y/ies), diff ${diff} exceeds tolerance ${rule.tolerance ?? 0}`,
        );
      }
      break;
    }
    case 'allCsvRowsHaveJsonMatch': {
      for (const key of csvByKey.keys()) {
        if (!jsonByKey.has(key)) violations.push(`allCsvRowsHaveJsonMatch: csv key "${key}" has no json match`);
      }
      break;
    }
    case 'allJsonEntriesHaveCsvMatch': {
      for (const key of jsonByKey.keys()) {
        if (!csvByKey.has(key)) violations.push(`allJsonEntriesHaveCsvMatch: json key "${key}" has no csv match`);
      }
      break;
    }
    case 'fieldsEqual': {
      for (const [key, csvRow] of csvByKey) {
        const jsonEntry = jsonByKey.get(key);
        if (!jsonEntry) continue; // reported by allCsvRowsHaveJsonMatch if that rule is also configured
        const csvValue = csvRow[rule.csvField];
        const jsonValue = jsonEntry[rule.jsonField];
        if (String(csvValue) !== String(jsonValue)) {
          violations.push(
            `fieldsEqual: key "${key}" csv.${rule.csvField}="${csvValue}" !== json.${rule.jsonField}="${jsonValue}"`,
          );
        }
      }
      break;
    }
    default: {
      const never: never = rule;
      throw new Error(`Unknown rule type: ${JSON.stringify(never)}`);
    }
  }

  return violations;
}

function checkOneEntry(entry: BusinessLogicEntry): void {
  if (!entry.csvPath) throw new Error('csvPath is required');
  if (!entry.jsonPath) throw new Error('jsonPath is required');
  if (!fs.existsSync(entry.csvPath)) throw new Error(`CSV file not found: ${entry.csvPath}`);
  if (!fs.existsSync(entry.jsonPath)) throw new Error(`JSON file not found: ${entry.jsonPath}`);
  if (!entry.rules || entry.rules.length === 0) throw new Error('rules must contain at least one rule');

  const { rows: csvRows } = parseCsv(fs.readFileSync(entry.csvPath, 'utf8'));
  const jsonEntries = JSON.parse(fs.readFileSync(entry.jsonPath, 'utf8'));
  if (!Array.isArray(jsonEntries)) {
    throw new Error(`JSON file's top-level value is not an array: ${entry.jsonPath}`);
  }

  const csvByKey = new Map(csvRows.map(r => [String(r[entry.csvKeyField]), r]));
  const jsonByKey = new Map(
    (jsonEntries as Record<string, unknown>[]).map(e => [String(e[entry.jsonKeyField]), e]),
  );

  const violations = entry.rules.flatMap(rule => checkRule(rule, csvRows, jsonEntries, csvByKey, jsonByKey));

  if (violations.length > 0) {
    throw new Error(`${violations.length} rule violation(s):\n${violations.map(v => `  - ${v}`).join('\n')}`);
  }
}

export function runAll(config: ValidateBusinessLogicConfig, ctx: StepContext): StepResult {
  if (!config.files || config.files.length === 0) {
    throw new Error('config.files must contain at least one file');
  }

  const outputs: Record<string, string | number | boolean> = {
    totalFiles: config.files.length,
  };

  for (let index = 0; index < config.files.length; index++) {
    const entry = config.files[index];
    const name = entry.name ?? `f${index}`;
    try {
      checkOneEntry(entry);
    } catch (err) {
      throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
    }
    ctx.log(`"${entry.csvPath}" vs "${entry.jsonPath}" (${name}): all ${entry.rules.length} rule(s) passed`);
    outputs[`${name}_status`] = 'Succeeded';
    outputs[`${name}_rulesChecked`] = entry.rules.length;
  }

  return { outputs };
}

export default defineStep<ValidateBusinessLogicConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/validate-business-logic.test.ts`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/validate-business-logic.ts steps/validate-business-logic.test.ts
git commit -m "feat: add validate-business-logic step"
```

---

### Task 5: Example configs, YAML wiring, and README

**Files:**
- Create: `configs/verify-row-count.json`, `configs/validate-json-schema.json`, `configs/validate-business-logic.json`, `configs/schemas/outbound-result-schema.json`
- Modify: `.pipelines/azure-pipelines.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `VerifyRowCountConfig` (Task 2), `ValidateJsonSchemaConfig` (Task 3), `ValidateBusinessLogicConfig` (Task 4). Also consumes existing pipeline output keys from earlier groups: `genUsersCsv.outputs.usersCsv_csvPath` (Group A) and `verifyResult.outputs.result_localPath` (Group B).

- [ ] **Step 1: Create the schema file and three example configs**

Create `configs/schemas/outbound-result-schema.json`:

```json
{
  "type": "array",
  "items": {
    "type": "object",
    "required": ["id", "status"],
    "properties": {
      "id": { "type": "string" },
      "status": { "type": "string" }
    }
  }
}
```

Create `configs/verify-row-count.json`:

```json
{
  "files": [
    {
      "name": "outboundResult",
      "filePath": "{{steps.verifyResult.outputs.result_localPath}}",
      "format": "json",
      "minRows": 1
    }
  ]
}
```

Create `configs/validate-json-schema.json`:

```json
{
  "files": [
    {
      "name": "outboundResult",
      "filePath": "{{steps.verifyResult.outputs.result_localPath}}",
      "schemaPath": "configs/schemas/outbound-result-schema.json"
    }
  ]
}
```

Create `configs/validate-business-logic.json`:

```json
{
  "files": [
    {
      "name": "usersVsResult",
      "csvPath": "{{steps.genUsersCsv.outputs.usersCsv_csvPath}}",
      "jsonPath": "{{steps.verifyResult.outputs.result_localPath}}",
      "csvKeyField": "id",
      "jsonKeyField": "id",
      "rules": [
        { "type": "rowCountMatches" },
        { "type": "allCsvRowsHaveJsonMatch" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Add the three new steps to the YAML's Deliver stage**

In `.pipelines/azure-pipelines.yml`, the `Deliver` stage's `ship_data` job currently ends with the `verifyResult` step (added in the `trigger-adf-pipeline`/Group B work). Add three new steps after it — these are pure local-file steps, so unlike `verifyResult` they need no `env:` block:

```yaml
          # ---- Step: verify the outbound result's row count -------------
          - script: >
              npx tsx runner/run-step.ts
              --step steps/verify-row-count.ts
              --config configs/verify-row-count.json
              --name verifyRowCount
            name: verifyRowCount
            displayName: 'Verify outbound result row count'

          # ---- Step: validate the outbound result against its schema ---
          - script: >
              npx tsx runner/run-step.ts
              --step steps/validate-json-schema.ts
              --config configs/validate-json-schema.json
              --name validateSchema
            name: validateSchema
            displayName: 'Validate outbound result JSON schema'

          # ---- Step: cross-check inbound CSV against outbound result ---
          - script: >
              npx tsx runner/run-step.ts
              --step steps/validate-business-logic.ts
              --config configs/validate-business-logic.json
              --name validateBusinessLogic
            name: validateBusinessLogic
            displayName: 'Validate inbound/outbound business logic'
```

- [ ] **Step 3: Update README.md**

Update the `Layout` section's `steps/` listing to add (alongside the existing `lib/blob-client.ts` line):

```
    csv.ts                    # shared CSV parser (used by verify-row-count, validate-business-logic)
  verify-row-count.ts         # check a file's row/entry count against a min/max range
  validate-json-schema.ts     # validate a JSON file against a caller-supplied JSON Schema
  validate-business-logic.ts  # declarative cross-file rules (e.g. inbound CSV vs outbound JSON)
```

Update the `configs/` listing to add:

```
  verify-row-count.json
  validate-json-schema.json
  validate-business-logic.json
  schemas/outbound-result-schema.json
```

Update the existing "one exception to standalone" note (added during Group B) to cover both shared libs:

```markdown
The two exceptions to "every step is standalone": `steps/lib/blob-client.ts`
(shared by the three blob-storage steps) and `steps/lib/csv.ts` (shared by
`verify-row-count` and `validate-business-logic`) — both cases where three
or two steps needed identical, non-trivial logic and duplicating it bought
nothing.
```

Add a new runnable example to the `## Running` section, after the existing blob storage example:

```markdown
Payload validation steps (pure local file I/O, no external auth needed):

\`\`\`bash
npx tsx runner/run-step.ts \
  --step steps/verify-row-count.ts \
  --config configs/verify-row-count.json \
  --name verifyRowCount

npx tsx runner/run-step.ts \
  --step steps/validate-json-schema.ts \
  --config configs/validate-json-schema.json \
  --name validateSchema

npx tsx runner/run-step.ts \
  --step steps/validate-business-logic.ts \
  --config configs/validate-business-logic.json \
  --name validateBusinessLogic
\`\`\`
```

Add a new `## Payload Validation` section after the existing `## Azure Blob Storage` section:

```markdown
## Payload Validation

`verify-row-count`, `validate-json-schema`, and `validate-business-logic`
are pure local-file steps — no Azure auth, no network calls. All three
process their `files` array **sequentially** and **fail fast** (unlike the
blob storage steps' concurrent/wait-for-all model), since these are
synchronous local reads, not independent network calls.
`validate-business-logic`'s rule set is declarative and bounded on
purpose — see the four `Rule` types in `steps/validate-business-logic.ts`
— rather than accepting arbitrary custom validator code, keeping every
step's config as plain JSON data.
```

- [ ] **Step 4: Verify the new configs/schema parse and the full suite still passes**

Run:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/schemas/outbound-result-schema.json', 'utf8')))"
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/verify-row-count.json', 'utf8')))"
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/validate-json-schema.json', 'utf8')))"
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/validate-business-logic.json', 'utf8')))"
npm test
npm run typecheck
```
Expected: all four `node -e` calls print the parsed object with no error; `npm test` shows all tests passing (Task 1: 7, Task 2: 6, Task 3: 5, Task 4: 6 — 24 new, plus the 50 already in the repo from Groups A/B — 74 total); `npm run typecheck` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add configs/verify-row-count.json configs/validate-json-schema.json configs/validate-business-logic.json configs/schemas/outbound-result-schema.json .pipelines/azure-pipelines.yml README.md
git commit -m "docs: wire payload validation steps into pipeline YAML and README"
```
