# Publish to Confluence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new pipeline step, `publish-to-confluence`, that reads `consolidate-run-results`' output JSON and publishes it as a single, in-place-updated Confluence Cloud page, wired into its own segregated pipeline stage.

**Architecture:** A new, self-contained step file (no shared lib with any other step — this is the only step in the whole feature set talking to Confluence). `defineStep` wraps an exported `runAll(config, ctx, fetchImpl?)`: validate config → read+parse the results JSON → render Confluence storage-format XHTML → search for an existing page by title+space → create or update accordingly. This is a single linear flow (search, then one write), not a batch — no concurrency model needed, unlike every other multi-item step in this feature set.

**Tech Stack:** TypeScript, Node's global `fetch` (dependency-injected as `FetchLike`, same pattern as `trigger-adf-pipeline.ts`/`extract-adf-run-details.ts`), `Buffer` (Basic Auth header encoding, no new dependency), `tsx --test` / `node:test` / `node:assert/strict`.

## Global Constraints

- No new npm dependencies.
- `npm run typecheck` (tsc --noEmit) must pass after every task that touches `.ts` files.
- Confluence Cloud only, Basic Auth (`email` + `apiToken`, base64-encoded into the `Authorization` header) — no Server/Data Center support.
- Single page per config, updated in place: search by `spaceKey`+`pageTitle`, `PUT` with an incremented `version.number` if found, `POST` (with optional `ancestors`) if not.
- Content is rendered directly to Confluence storage-format XHTML — no Markdown, no separate conversion step/library.
- Every dynamic string value inserted into the rendered content must be XHTML-escaped (`&`, `<`, `>`, `"`).
- No retry of a failed Confluence API call, including a `409` version conflict — matches this feature set's established "no retry of a one-shot REST call" precedent.
- The rendered content is also written to a local artifact file `confluence-page-content.html` before the API call, for audit/debugging.
- This step is deliberately self-contained: it defines its own local types matching `consolidate-run-results`' output JSON shape rather than importing from `steps/consolidate-run-results.ts` — steps in this repo communicate via files on disk and interpolated config strings, never by importing each other's TypeScript.
- Test command for this feature: `npx tsx --test steps/publish-to-confluence.test.ts`.

---

## File Structure

- **Create:** `steps/publish-to-confluence.ts` — the step module (types, pure helpers, network layer, orchestration, default export).
- **Create:** `steps/publish-to-confluence.test.ts` — unit tests, built up across Tasks 1–3.
- **Create:** `configs/publish-to-confluence.json` — example config.
- **Modify:** `.pipelines/azure-pipelines.yml` — add a `PublishPipelineArtifact@1` task to the `Deliver` stage's job (it doesn't have one yet — only `Generate` does), and add a new `Publish` stage.
- **Modify:** `README.md` — Layout/configs listings, a new `## Running` example.

---

### Task 1: Config types, XHTML escaping, and content rendering

**Files:**
- Create: `steps/publish-to-confluence.ts`
- Create: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Produces: `PublishToConfluenceConfig { baseUrl, email, apiToken, spaceKey, pageTitle, parentPageId?, resultsPath }`; `ConsolidatedStepEntry { stepName, ok, outputs, error? }`; `ConsolidatedResult { runMetadata, generatedAt, steps: ConsolidatedStepEntry[], summary: { totalSteps, succeededCount, failedCount } }`; `escapeXhtml(value: unknown): string`; `renderConfluenceStorageFormat(result: ConsolidatedResult): string`.

- [ ] **Step 1: Write the failing tests**

Create `steps/publish-to-confluence.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeXhtml, renderConfluenceStorageFormat } from './publish-to-confluence';

test('escapeXhtml escapes &, <, >, and "', () => {
  assert.equal(escapeXhtml('<b>a & "b"</b>'), '&lt;b&gt;a &amp; &quot;b&quot;&lt;/b&gt;');
});

test('escapeXhtml converts non-string values to strings before escaping', () => {
  assert.equal(escapeXhtml(42), '42');
  assert.equal(escapeXhtml(true), 'true');
  assert.equal(escapeXhtml(null), '');
  assert.equal(escapeXhtml(undefined), '');
});

test('renderConfluenceStorageFormat includes run metadata, summary counts, and per-step rows', () => {
  const result = {
    runMetadata: { buildId: '123' },
    generatedAt: '2026-07-20T00:00:00.000Z',
    steps: [
      { stepName: 'genUsersCsv', ok: true, outputs: { usersCsv_rowCount: 250 } },
      { stepName: 'extractAdfDetails', ok: false, outputs: {}, error: 'boom' },
    ],
    summary: { totalSteps: 2, succeededCount: 1, failedCount: 1 },
  };
  const html = renderConfluenceStorageFormat(result);
  assert.match(html, /123/);
  assert.match(html, /genUsersCsv/);
  assert.match(html, /Succeeded/);
  assert.match(html, /extractAdfDetails/);
  assert.match(html, /Failed/);
  assert.match(html, /boom/);
  assert.match(html, /usersCsv_rowCount: 250/);
});

test('renderConfluenceStorageFormat XHTML-escapes a step name and error containing special characters', () => {
  const result = {
    runMetadata: {},
    generatedAt: 't',
    steps: [{ stepName: '<script>', ok: false, outputs: {}, error: 'a & b' }],
    summary: { totalSteps: 1, succeededCount: 0, failedCount: 1 },
  };
  const html = renderConfluenceStorageFormat(result);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/publish-to-confluence.test.ts`
Expected: FAIL — `steps/publish-to-confluence.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write the implementation**

Create `steps/publish-to-confluence.ts`:

```ts
/**
 * Step: publish-to-confluence (TypeScript)
 *
 * Reads consolidate-run-results' output JSON and publishes it as a single
 * Confluence Cloud page — creating it on first run, updating it in place
 * (with an incremented version number) on every run after. Content is
 * rendered directly to Confluence storage format (XHTML), sent via the
 * REST API. Auth is Basic (email + API token), matching this repo's
 * "secrets are never auto-exposed" convention — config.email/apiToken are
 * typically "{{env.CONFLUENCE_EMAIL}}"/"{{env.CONFLUENCE_API_TOKEN}}".
 *
 * Deliberately self-contained: defines its own local types matching
 * consolidate-run-results' output shape rather than importing from that
 * step's module — steps in this repo communicate via files on disk and
 * interpolated config strings, never by importing each other's TS.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';

// ---------- Config types ----------------------------------------------------

export interface PublishToConfluenceConfig {
  /** e.g. "https://yoursite.atlassian.net/wiki" */
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey: string;
  pageTitle: string;
  /** Optional parent page to create the page under, if it doesn't exist yet. */
  parentPageId?: string;
  /** Path to the JSON artifact produced by consolidate-run-results. */
  resultsPath: string;
}

export interface ConsolidatedStepEntry {
  stepName: string;
  ok: boolean;
  outputs: Record<string, string | number | boolean>;
  error?: string;
}

export interface ConsolidatedResult {
  runMetadata: Record<string, string>;
  generatedAt: string;
  steps: ConsolidatedStepEntry[];
  summary: {
    totalSteps: number;
    succeededCount: number;
    failedCount: number;
  };
}

// ---------- XHTML escaping ---------------------------------------------------

export function escapeXhtml(value: unknown): string {
  const s = value == null ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- Content rendering ------------------------------------------------

export function renderConfluenceStorageFormat(result: ConsolidatedResult): string {
  const metadataRows = Object.entries(result.runMetadata)
    .map(([k, v]) => `<tr><th>${escapeXhtml(k)}</th><td>${escapeXhtml(v)}</td></tr>`)
    .join('');

  const stepRows = result.steps
    .map(step => {
      const outputsList = Object.entries(step.outputs)
        .map(([k, v]) => `${escapeXhtml(k)}: ${escapeXhtml(v)}`)
        .join('<br/>');
      const status = step.ok ? 'Succeeded' : 'Failed';
      const errorCell = step.error ? `<br/><strong>Error:</strong> ${escapeXhtml(step.error)}` : '';
      return `<tr><td>${escapeXhtml(step.stepName)}</td><td>${status}${errorCell}</td><td>${outputsList}</td></tr>`;
    })
    .join('');

  return `<h2>Run Summary</h2>
<table><tbody>
${metadataRows}
<tr><th>Generated At</th><td>${escapeXhtml(result.generatedAt)}</td></tr>
<tr><th>Total Steps</th><td>${result.summary.totalSteps}</td></tr>
<tr><th>Succeeded</th><td>${result.summary.succeededCount}</td></tr>
<tr><th>Failed</th><td>${result.summary.failedCount}</td></tr>
</tbody></table>
<h2>Step Results</h2>
<table><thead><tr><th>Step</th><th>Status</th><th>Outputs</th></tr></thead><tbody>
${stepRows}
</tbody></table>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/publish-to-confluence.test.ts`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Unused imports `fs`, `path`, `defineStep`, `StepContext`, `StepResult` are fine — later tasks use them, and this repo's tsconfig doesn't set `noUnusedLocals`.)

- [ ] **Step 6: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "feat: add config types, XHTML escaping, and content rendering for publish-to-confluence step"
```

---

### Task 2: Confluence REST network layer

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Modify: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1 (parallel concern), but appends to the same two files.
- Produces: `FetchLike` type (`(url, init?) => Promise<{ ok, status, json(), text() }>`); `findExistingPage(config, fetchImpl): Promise<{ id: string; version: number } | null>`; `createPage(config, content, fetchImpl): Promise<{ id: string; url: string }>`; `updatePage(config, pageId, currentVersion, content, fetchImpl): Promise<{ id: string; url: string }>`.

- [ ] **Step 1: Write the failing tests**

Append to `steps/publish-to-confluence.test.ts` (new import line plus new tests):

```ts
import { findExistingPage, createPage, updatePage, type FetchLike } from './publish-to-confluence';

const CONFIG = {
  baseUrl: 'https://example.atlassian.net/wiki',
  email: 'me@example.com',
  apiToken: 'token123',
  spaceKey: 'ENG',
  pageTitle: 'Pipeline Run Status',
  resultsPath: 'unused-for-these-tests.json',
};

test('findExistingPage returns id and version when a page is found', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true, status: 200,
    json: async () => ({ results: [{ id: '123', version: { number: 4 } }] }),
    text: async () => '',
  });
  const found = await findExistingPage(CONFIG, fetchImpl);
  assert.deepEqual(found, { id: '123', version: 4 });
});

test('findExistingPage returns null when no page is found', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' });
  const found = await findExistingPage(CONFIG, fetchImpl);
  assert.equal(found, null);
});

test('findExistingPage throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'Unauthorized' });
  await assert.rejects(() => findExistingPage(CONFIG, fetchImpl), /HTTP 401[\s\S]*Unauthorized/);
});

test('createPage sends a POST with a Basic auth header and storage-format body, and includes ancestors when parentPageId is set', async () => {
  let capturedUrl = '';
  let capturedMethod = '';
  let capturedHeaders: Record<string, string> | undefined;
  let capturedBody: any;
  const fetchImpl: FetchLike = async (url, init) => {
    capturedUrl = url;
    capturedMethod = init?.method ?? '';
    capturedHeaders = init?.headers;
    capturedBody = JSON.parse(init?.body ?? '{}');
    return { ok: true, status: 200, json: async () => ({ id: 'new-1', _links: { webui: '/spaces/ENG/pages/new-1' } }), text: async () => '' };
  };
  const result = await createPage({ ...CONFIG, parentPageId: 'parent-1' }, '<p>content</p>', fetchImpl);
  assert.equal(capturedMethod, 'POST');
  assert.match(capturedUrl, /\/rest\/api\/content$/);
  assert.equal(capturedHeaders?.Authorization, `Basic ${Buffer.from('me@example.com:token123').toString('base64')}`);
  assert.deepEqual(capturedBody.ancestors, [{ id: 'parent-1' }]);
  assert.equal(capturedBody.body.storage.value, '<p>content</p>');
  assert.equal(result.id, 'new-1');
  assert.equal(result.url, 'https://example.atlassian.net/wiki/spaces/ENG/pages/new-1');
});

test('createPage omits ancestors when parentPageId is not set', async () => {
  let capturedBody: any;
  const fetchImpl: FetchLike = async (_url, init) => {
    capturedBody = JSON.parse(init?.body ?? '{}');
    return { ok: true, status: 200, json: async () => ({ id: 'new-1', _links: { webui: '/x' } }), text: async () => '' };
  };
  await createPage(CONFIG, '<p>content</p>', fetchImpl);
  assert.equal('ancestors' in capturedBody, false);
});

test('createPage throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => 'Bad Request' });
  await assert.rejects(() => createPage(CONFIG, '<p/>', fetchImpl), /HTTP 400[\s\S]*Bad Request/);
});

test('updatePage sends a PUT to the page-specific URL with an incremented version number', async () => {
  let capturedMethod = '';
  let capturedBody: any;
  let capturedUrl = '';
  const fetchImpl: FetchLike = async (url, init) => {
    capturedUrl = url;
    capturedMethod = init?.method ?? '';
    capturedBody = JSON.parse(init?.body ?? '{}');
    return { ok: true, status: 200, json: async () => ({ id: '123', _links: { webui: '/spaces/ENG/pages/123' } }), text: async () => '' };
  };
  const result = await updatePage(CONFIG, '123', 4, '<p>updated</p>', fetchImpl);
  assert.equal(capturedMethod, 'PUT');
  assert.match(capturedUrl, /\/rest\/api\/content\/123$/);
  assert.equal(capturedBody.version.number, 5);
  assert.equal(result.id, '123');
});

test('updatePage throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 409, json: async () => ({}), text: async () => 'Conflict' });
  await assert.rejects(() => updatePage(CONFIG, '123', 4, '<p/>', fetchImpl), /HTTP 409[\s\S]*Conflict/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/publish-to-confluence.test.ts`
Expected: FAIL — `findExistingPage`/`createPage`/`updatePage`/`FetchLike` are not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `steps/publish-to-confluence.ts` (after the "Content rendering" section):

```ts
// ---------- Network layer (dependency-injected for testing) -------------------

export interface FetchLike {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;
}

function authHeader(email: string, apiToken: string): string {
  const encoded = Buffer.from(`${email}:${apiToken}`).toString('base64');
  return `Basic ${encoded}`;
}

export async function findExistingPage(
  config: PublishToConfluenceConfig,
  fetchImpl: FetchLike,
): Promise<{ id: string; version: number } | null> {
  const url = `${config.baseUrl}/rest/api/content?spaceKey=${encodeURIComponent(config.spaceKey)}&title=${encodeURIComponent(config.pageTitle)}&expand=version`;
  const res = await fetchImpl(url, {
    headers: { Authorization: authHeader(config.email, config.apiToken) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Confluence page search failed (HTTP ${res.status}): ${body}`);
  }
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;
  return { id: data.results[0].id, version: data.results[0].version.number };
}

export async function createPage(
  config: PublishToConfluenceConfig,
  content: string,
  fetchImpl: FetchLike,
): Promise<{ id: string; url: string }> {
  const body: Record<string, unknown> = {
    type: 'page',
    title: config.pageTitle,
    space: { key: config.spaceKey },
    body: { storage: { value: content, representation: 'storage' } },
  };
  if (config.parentPageId) body.ancestors = [{ id: config.parentPageId }];

  const res = await fetchImpl(`${config.baseUrl}/rest/api/content`, {
    method: 'POST',
    headers: { Authorization: authHeader(config.email, config.apiToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const respBody = await res.text();
    throw new Error(`Confluence page create failed (HTTP ${res.status}): ${respBody}`);
  }
  const data = await res.json();
  return { id: data.id, url: `${config.baseUrl}${data._links.webui}` };
}

export async function updatePage(
  config: PublishToConfluenceConfig,
  pageId: string,
  currentVersion: number,
  content: string,
  fetchImpl: FetchLike,
): Promise<{ id: string; url: string }> {
  const body = {
    id: pageId,
    type: 'page',
    title: config.pageTitle,
    space: { key: config.spaceKey },
    body: { storage: { value: content, representation: 'storage' } },
    version: { number: currentVersion + 1 },
  };

  const res = await fetchImpl(`${config.baseUrl}/rest/api/content/${pageId}`, {
    method: 'PUT',
    headers: { Authorization: authHeader(config.email, config.apiToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const respBody = await res.text();
    throw new Error(`Confluence page update failed (HTTP ${res.status}): ${respBody}`);
  }
  const data = await res.json();
  return { id: data.id, url: `${config.baseUrl}${data._links.webui}` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/publish-to-confluence.test.ts`
Expected: PASS — 12 tests total, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "feat: add Confluence REST network layer to publish-to-confluence step"
```

---

### Task 3: Orchestration and step export

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Modify: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2 (`renderConfluenceStorageFormat`, `findExistingPage`, `createPage`, `updatePage`, `FetchLike`, `PublishToConfluenceConfig`, `ConsolidatedResult`).
- Produces: `runAll(config: PublishToConfluenceConfig, ctx: StepContext, fetchImpl?: FetchLike): Promise<StepResult>`; the module's `default` export (a `StepModule<PublishToConfluenceConfig>` built with `defineStep`).

- [ ] **Step 1: Write the failing tests**

Append to `steps/publish-to-confluence.test.ts`:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './publish-to-confluence';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

function writeResultsFile(dir: string): string {
  const filePath = path.join(dir, 'run-results.json');
  fs.writeFileSync(filePath, JSON.stringify({
    runMetadata: { buildId: '1' },
    generatedAt: 't',
    steps: [{ stepName: 'a', ok: true, outputs: {} }],
    summary: { totalSteps: 1, succeededCount: 1, failedCount: 0 },
  }));
  return filePath;
}

test('runAll creates a new page when none exists, writing the content artifact', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-test-'));
  try {
    const resultsPath = writeResultsFile(outDir);
    const fetchImpl: FetchLike = async url => {
      if (url.includes('spaceKey=')) {
        return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'new-1', _links: { webui: '/x' } }), text: async () => '' };
    };
    const config = {
      baseUrl: 'https://example.atlassian.net/wiki', email: 'e', apiToken: 't',
      spaceKey: 'ENG', pageTitle: 'Status', resultsPath,
    };
    const result = await runAll(config, fakeCtx(outDir), fetchImpl);
    assert.equal(result.outputs?.action, 'created');
    assert.equal(result.outputs?.pageId, 'new-1');
    const artifactPath = path.join(outDir, 'confluence-page-content.html');
    assert.ok(fs.existsSync(artifactPath));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll updates the existing page when one is found', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-test-'));
  try {
    const resultsPath = writeResultsFile(outDir);
    const fetchImpl: FetchLike = async url => {
      if (url.includes('spaceKey=')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ id: '123', version: { number: 2 } }] }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ id: '123', _links: { webui: '/x' } }), text: async () => '' };
    };
    const config = {
      baseUrl: 'https://example.atlassian.net/wiki', email: 'e', apiToken: 't',
      spaceKey: 'ENG', pageTitle: 'Status', resultsPath,
    };
    const result = await runAll(config, fakeCtx(outDir), fetchImpl);
    assert.equal(result.outputs?.action, 'updated');
    assert.equal(result.outputs?.pageId, '123');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws when a required config field is missing', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-test-'));
  try {
    const resultsPath = writeResultsFile(outDir);
    const config = { baseUrl: '', email: 'e', apiToken: 't', spaceKey: 'ENG', pageTitle: 'Status', resultsPath };
    await assert.rejects(() => runAll(config as any, fakeCtx(outDir)), /baseUrl is required/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws when resultsPath does not exist', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-test-'));
  try {
    const config = {
      baseUrl: 'https://example.atlassian.net/wiki', email: 'e', apiToken: 't',
      spaceKey: 'ENG', pageTitle: 'Status', resultsPath: path.join(outDir, 'missing.json'),
    };
    await assert.rejects(() => runAll(config, fakeCtx(outDir)), /Results file not found/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test steps/publish-to-confluence.test.ts`
Expected: FAIL — `runAll` is not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `steps/publish-to-confluence.ts` (after the "Network layer" section):

```ts
// ---------- Orchestration ----------------------------------------------------

const REQUIRED_CONFIG_FIELDS: Array<keyof PublishToConfluenceConfig> = [
  'baseUrl',
  'email',
  'apiToken',
  'spaceKey',
  'pageTitle',
  'resultsPath',
];

export async function runAll(
  config: PublishToConfluenceConfig,
  ctx: StepContext,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<StepResult> {
  for (const field of REQUIRED_CONFIG_FIELDS) {
    if (!config[field]) throw new Error(`config.${field} is required`);
  }

  if (!fs.existsSync(config.resultsPath)) {
    throw new Error(`Results file not found: ${config.resultsPath}`);
  }
  const result: ConsolidatedResult = JSON.parse(fs.readFileSync(config.resultsPath, 'utf8'));

  const content = renderConfluenceStorageFormat(result);
  const contentPath = path.join(ctx.outDir, 'confluence-page-content.html');
  fs.writeFileSync(contentPath, content);

  const existing = await findExistingPage(config, fetchImpl);
  let published: { id: string; url: string };
  let action: 'created' | 'updated';

  if (existing) {
    published = await updatePage(config, existing.id, existing.version, content, fetchImpl);
    action = 'updated';
  } else {
    published = await createPage(config, content, fetchImpl);
    action = 'created';
  }

  ctx.log(`${action === 'created' ? 'Created' : 'Updated'} Confluence page "${config.pageTitle}" -> ${published.url}`);

  return {
    outputs: {
      pageId: published.id,
      pageUrl: published.url,
      action,
    },
    artifacts: [contentPath],
  };
}

export default defineStep<PublishToConfluenceConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test steps/publish-to-confluence.test.ts`
Expected: PASS — 16 tests total, 0 failures.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "feat: add runAll orchestration and default step export for publish-to-confluence"
```

---

### Task 4: Example config, YAML wiring, and README

**Files:**
- Create: `configs/publish-to-confluence.json`
- Modify: `.pipelines/azure-pipelines.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `PublishToConfluenceConfig` from Task 1; `consolidate-run-results`' known output file location (`step-output/consolidateResults/run-results.json`, given the example config from Group D2 doesn't set a custom `fileName`).

- [ ] **Step 1: Create the example config**

Create `configs/publish-to-confluence.json`:

```json
{
  "baseUrl": "https://yoursite.atlassian.net/wiki",
  "email": "{{env.CONFLUENCE_EMAIL}}",
  "apiToken": "{{env.CONFLUENCE_API_TOKEN}}",
  "spaceKey": "ENG",
  "pageTitle": "Pipeline Run Status",
  "resultsPath": "{{env.PIPELINE_WORKSPACE}}/step-output/consolidateResults/run-results.json"
}
```

**Why `{{env.PIPELINE_WORKSPACE}}` and not `{{steps.consolidateResults.outputs.consolidatedPath}}`:** this step runs in a brand-new pipeline **stage** (`Publish`, added below), which gets a fresh agent workspace — `{{steps.X.outputs.Y}}` would interpolate the literal absolute path *recorded* by `consolidateResults` when it ran in the `Deliver` stage's workspace, which won't exist on the `Publish` stage's agent. `PIPELINE_WORKSPACE` is already set as a pipeline-wide variable (`.pipelines/azure-pipelines.yml`'s top-level `variables:` block) and is automatically exposed as an env var to every job, so `{{env.PIPELINE_WORKSPACE}}` always resolves to the *current* job's own workspace — exactly the same mechanism `runner/run-step.ts`'s own `workspaceRoot()` already uses internally. This is the same pattern the existing `Deliver` stage already uses (its `cat $(Pipeline.Workspace)/step-output/gpgEncryptCsv/output.json` line reconstructs a path relative to its own workspace rather than trusting a cross-stage absolute path).

- [ ] **Step 2: Add an artifact-publish task to Deliver, and a new Publish stage**

In `.pipelines/azure-pipelines.yml`, the `Deliver` stage's `ship_data` job currently ends with the `consolidateResults` step (ending around the line with `BUILD_SOURCEBRANCH: $(Build.SourceBranch)`) and has no `PublishPipelineArtifact@1` task of its own (only `Generate`'s job has one, publishing artifact name `step-output`). Add one at the end of `ship_data`'s steps, using a **different** artifact name (`step-output` is already taken by `Generate`'s publish):

```yaml
          - task: PublishPipelineArtifact@1
            displayName: 'Publish run results artifact'
            inputs:
              targetPath: '$(Pipeline.Workspace)/step-output'
              artifact: 'step-output-final'
```

This publishes the *merged* tree (Generate's original outputs, downloaded at the top of this job, plus everything `Deliver`'s own steps — including `consolidateResults` — added to that same local `step-output/` directory), so the new stage below can get everything in one download.

Then add a new stage after `Deliver` (top-level, same indentation as `- stage: Generate` and `- stage: Deliver`):

```yaml
  - stage: Publish
    dependsOn: Deliver
    condition: succeededOrFailed()
    jobs:
      - job: publish_confluence
        steps:
          - download: current
            artifact: step-output-final

          # ---- Step: publish consolidated run results to Confluence ---
          - script: >
              npx tsx runner/run-step.ts
              --step steps/publish-to-confluence.ts
              --config configs/publish-to-confluence.json
              --name publishConfluence
            name: publishConfluence
            displayName: 'Publish run results to Confluence'
            env:
              CONFLUENCE_EMAIL: $(confluence-email)
              CONFLUENCE_API_TOKEN: $(confluence-api-token)
```

`condition: succeededOrFailed()` on the *stage* mirrors `consolidateResults`' own `condition: always()` one level down — the `Publish` stage still runs even if something failed inside `Deliver`. It does not fix the pre-existing, documented gap where a `Generate`-stage failure skips `Deliver` (and therefore `Publish`) entirely via the pipeline's `dependsOn` topology — that remains explicitly out of scope (see the design spec).

- [ ] **Step 3: Update README.md**

Update the `Layout` section's `steps/` listing to add:

```
  publish-to-confluence.ts    # publish consolidated run results as a Confluence Cloud page
```

Update the `configs/` listing to add:

```
  publish-to-confluence.json
```

Add a new runnable example to the `## Running` section, after the existing `consolidate-run-results` example:

```markdown
Publish to Confluence (needs `CONFLUENCE_EMAIL`/`CONFLUENCE_API_TOKEN`, and
a `run-results.json` already produced by `consolidate-run-results`):

\`\`\`bash
export CONFLUENCE_EMAIL="you@example.com"
export CONFLUENCE_API_TOKEN="..."
npx tsx runner/run-step.ts \
  --step steps/publish-to-confluence.ts \
  --config configs/publish-to-confluence.json \
  --name publishConfluence
\`\`\`
```

- [ ] **Step 4: Verify the new config parses and the full suite still passes**

Run:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('configs/publish-to-confluence.json', 'utf8')))"
npm test
npm run typecheck
```
Expected: the `node -e` call prints the parsed object with no error; `npm test` shows all tests passing (16 new from this plan, plus the pre-existing suite — 112 tests as of this repo's last count — for 128 total); `npm run typecheck` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add configs/publish-to-confluence.json .pipelines/azure-pipelines.yml README.md
git commit -m "docs: wire publish-to-confluence step into its own pipeline stage and README"
```
