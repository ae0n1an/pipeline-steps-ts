# Confluence Report Templating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `consolidate-run-results` embed a step's full JSON artifact (not just its flat outputs) and let `publish-to-confluence` render a declarative `sections` config (table/bullets/keyvalue layouts, explicit field selection, automatic nested bullets for object/array cell values) instead of one fixed layout.

**Architecture:** `consolidate-run-results` gains an `embedArtifacts` config that reads a named artifact file per step and attaches its parsed JSON under that step's `data` field. `publish-to-confluence` gains a `sections` config; when present it replaces the generic "Step Results" table with custom-rendered sections pulling from either a step's `outputs` or its `data`. When `sections` is omitted, both steps behave exactly as they do today.

**Tech Stack:** TypeScript, `node:test`/`node:assert/strict`, `tsx`.

## Global Constraints

- `consolidate-run-results`'s `embedArtifacts` map validates *before* any file I/O: throws if it names a step not in `stepNames`. Per-step artifact lookup then throws if no artifact basename matches, or if the matched file isn't valid JSON.
- `publish-to-confluence`'s `sections` config is fully backward compatible: omitted or empty array → identical output to today (`renderConfluenceStorageFormat`'s existing generic "Step Results" table). All 16 of today's `publish-to-confluence.test.ts` tests and all 9 of today's `consolidate-run-results.test.ts` tests must keep passing unchanged.
- The "Run Summary" block (build metadata + `generatedAt` + totals) is unconditional — always rendered first, `sections` or not.
- `layout: 'table'` requires the resolved data to be an array (throws naming the section title otherwise). When `fields` is omitted, the column set is the **first array item's own enumerable keys** (documented assumption — do not attempt to union keys across items).
- `layout: 'keyvalue'` requires the resolved data to be a plain object (throws, suggesting `layout: "bullets"`, if it's an array).
- `layout: 'bullets'`: array data → each item gets its own `<p><strong>Item N</strong></p>` heading (1-indexed) followed by a `<ul>` of that item's fields; object data → one flat `<ul>` of `label: value` lines. No `itemTitleField` — headings are always `Item N`.
- Cell-level nested rendering (inside `table` cells, and reused for `bullets`/`keyvalue` cell values) applies whenever a resolved value is a non-null object or array: object → flat `<ul>` of its own keys (no `fields` at this depth); array → one `<li>` per item, each recursively rendered the same way. This nested renderer is distinct from the section-level `bullets` layout (no `Item N` headings at this depth).
- A path that resolves to `undefined` (via `resolveFieldPath`) renders as an empty string, never throws.
- `escapeXhtml` (existing function) is the only place primitive values get escaped; do not duplicate escaping logic.
- Steps do not import each other's TS — `publish-to-confluence.ts` keeps its own local `ConsolidatedStepEntry`/`ConsolidatedResult` types (adding `data?: unknown` to mirror `consolidate-run-results.ts`'s new field, not importing it).

---

### Task 1: `embedArtifacts` in consolidate-run-results

**Files:**
- Modify: `steps/consolidate-run-results.ts` (replace entire file content with the version below)
- Modify: `steps/consolidate-run-results.test.ts` (append the 5 new tests below at the end of the file)

**Interfaces:**
- Produces: `ConsolidateRunResultsConfig.embedArtifacts?: Record<string, string>`; `ConsolidatedStepEntry.data?: unknown`. Task 2's `publish-to-confluence.ts` mirrors this `data?: unknown` field in its own local copy of `ConsolidatedStepEntry` (not imported).

- [ ] **Step 1: Replace `steps/consolidate-run-results.ts` with this complete file**

```ts
/**
 * Step: consolidate-run-results (TypeScript)
 *
 * Folds a named list of prior steps' outputs from the current run into
 * one structured JSON artifact, designed for trending over time and as
 * the input for a later Confluence-publishing step. No file I/O or
 * network calls beyond the final write and any embedArtifacts reads —
 * StepContext.steps already has everything needed, read from step-output
 * dirs (populated by runner).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult, type StepOutputFile } from '../runner/types';

export interface ConsolidateRunResultsConfig {
  stepNames: string[];
  /**
   * Step name -> artifact filename to also embed as parsed JSON under
   * that step's `data` field, alongside its existing flat `outputs`.
   * The filename is matched by basename against that step's own
   * StepOutputFile.artifacts list.
   */
  embedArtifacts?: Record<string, string>;
  /** Arbitrary key-value metadata, interpolated via {{env.VAR}} like any other config field. */
  runMetadata?: Record<string, string>;
  /** Output artifact filename; defaults to "run-results.json". */
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

function loadEmbeddedArtifact(stepName: string, fileName: string, stepOutput: StepOutputFile): unknown {
  const matchPath = stepOutput.artifacts.find(p => path.basename(p) === fileName);
  if (!matchPath) {
    const basenames = stepOutput.artifacts.map(p => path.basename(p)).join(', ') || '(none)';
    throw new Error(`Step "${stepName}": no artifact named "${fileName}" found (has: ${basenames})`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(matchPath, 'utf8');
  } catch (err) {
    throw new Error(`Step "${stepName}": failed to read embedded artifact "${matchPath}": ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Step "${stepName}": embedded artifact "${matchPath}" is not valid JSON: ${(err as Error).message}`);
  }
}

export function buildConsolidatedResult(
  config: ConsolidateRunResultsConfig,
  steps: Record<string, StepOutputFile>,
  now: () => string = () => new Date().toISOString(),
): ConsolidatedResult {
  if (!config.stepNames || config.stepNames.length === 0) {
    throw new Error('config.stepNames must contain at least one step name');
  }

  const missing = config.stepNames.filter(name => !(name in steps));
  if (missing.length > 0) {
    throw new Error(`Step(s) not found in this run's step outputs: ${missing.join(', ')}`);
  }

  const embedArtifacts = config.embedArtifacts ?? {};
  const unknownEmbeds = Object.keys(embedArtifacts).filter(name => !config.stepNames.includes(name));
  if (unknownEmbeds.length > 0) {
    throw new Error(`embedArtifacts references step(s) not in stepNames: ${unknownEmbeds.join(', ')}`);
  }

  const entries: ConsolidatedStepEntry[] = config.stepNames.map(stepName => {
    const stepOutput = steps[stepName];
    const entry: ConsolidatedStepEntry = {
      stepName,
      ok: stepOutput.ok,
      outputs: stepOutput.outputs ?? {},
    };
    if (stepOutput.error) entry.error = stepOutput.error.message;
    const embedFileName = embedArtifacts[stepName];
    if (embedFileName) {
      entry.data = loadEmbeddedArtifact(stepName, embedFileName, stepOutput);
    }
    return entry;
  });

  const succeededCount = entries.filter(e => e.ok).length;

  return {
    runMetadata: config.runMetadata ?? {},
    generatedAt: now(),
    steps: entries,
    summary: {
      totalSteps: entries.length,
      succeededCount,
      failedCount: entries.length - succeededCount,
    },
  };
}

export function runAll(config: ConsolidateRunResultsConfig, ctx: StepContext): StepResult {
  const result = buildConsolidatedResult(config, ctx.steps);

  const fileName = config.fileName ?? 'run-results.json';
  const filePath = path.join(ctx.outDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));

  ctx.log(
    `Consolidated ${result.summary.totalSteps} step(s): ${result.summary.succeededCount} succeeded, ${result.summary.failedCount} failed -> ${fileName}`,
  );

  return {
    outputs: {
      consolidatedPath: filePath,
      totalSteps: result.summary.totalSteps,
      succeededCount: result.summary.succeededCount,
      failedCount: result.summary.failedCount,
    },
    artifacts: [filePath],
  };
}

export default defineStep<ConsolidateRunResultsConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
```

- [ ] **Step 2: Append these 5 tests to the end of `steps/consolidate-run-results.test.ts`**

```ts
test("buildConsolidatedResult embeds a step's artifact JSON under data when embedArtifacts names it", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-embed-test-'));
  try {
    const artifactPath = path.join(outDir, 'adf-run-details.json');
    fs.writeFileSync(artifactPath, JSON.stringify({ pipelineRuns: [{ runId: 'r1' }], activities: [] }));
    const steps = {
      extractAdfDetails: fakeStepOutput({ ok: true, artifacts: [artifactPath] }),
    };
    const result = buildConsolidatedResult(
      { stepNames: ['extractAdfDetails'], embedArtifacts: { extractAdfDetails: 'adf-run-details.json' } },
      steps,
    );
    assert.deepEqual(result.steps[0].data, { pipelineRuns: [{ runId: 'r1' }], activities: [] });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('buildConsolidatedResult omits data when embedArtifacts is not configured for a step', () => {
  const steps = { a: fakeStepOutput() };
  const result = buildConsolidatedResult({ stepNames: ['a'] }, steps);
  assert.equal(result.steps[0].data, undefined);
});

test('buildConsolidatedResult throws when embedArtifacts references a step not in stepNames', () => {
  const steps = { a: fakeStepOutput() };
  assert.throws(
    () => buildConsolidatedResult({ stepNames: ['a'], embedArtifacts: { b: 'x.json' } }, steps),
    /embedArtifacts references step\(s\) not in stepNames: b/,
  );
});

test("buildConsolidatedResult throws when the named artifact is not found among the step's artifacts", () => {
  const steps = { a: fakeStepOutput({ artifacts: ['/tmp/other-file.json'] }) };
  assert.throws(
    () => buildConsolidatedResult({ stepNames: ['a'], embedArtifacts: { a: 'missing.json' } }, steps),
    /no artifact named "missing\.json" found \(has: other-file\.json\)/,
  );
});

test('buildConsolidatedResult throws when the embedded artifact file is not valid JSON', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-embed-test-'));
  try {
    const artifactPath = path.join(outDir, 'bad.json');
    fs.writeFileSync(artifactPath, 'not json{');
    const steps = { a: fakeStepOutput({ artifacts: [artifactPath] }) };
    assert.throws(
      () => buildConsolidatedResult({ stepNames: ['a'], embedArtifacts: { a: 'bad.json' } }, steps),
      /is not valid JSON/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

Note: `fs`, `os`, and `path` are already imported earlier in this file (before the existing `runAll` tests) — do not add duplicate imports.

- [ ] **Step 3: Run the tests**

Run: `npx tsx --test steps/consolidate-run-results.test.ts`
Expected: all 14 tests pass (9 existing + 5 new).

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add steps/consolidate-run-results.ts steps/consolidate-run-results.test.ts
git commit -m "feat: add embedArtifacts to consolidate-run-results for embedding a step's full JSON artifact"
```

---

### Task 2: `sections` templating in publish-to-confluence

**Files:**
- Modify: `steps/publish-to-confluence.ts` (replace entire file content with the version below)
- Modify: `steps/publish-to-confluence.test.ts` (append the 15 new tests below at the end of the file)

**Interfaces:**
- Consumes: nothing new from Task 1 (no imports across steps — this task adds its own local `data?: unknown` field to its own local `ConsolidatedStepEntry` type, matching Task 1's shape by convention only).
- Produces: `ReportSection` type; `resolveFieldPath(obj, fieldPath): unknown`; `renderConfluenceStorageFormat(result, sections?): string` (now takes an optional second parameter — existing callers/tests that pass only `result` are unaffected, since it's optional and falls back to today's behavior).

- [ ] **Step 1: Replace `steps/publish-to-confluence.ts` with this complete file**

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
 *
 * Rendering has two modes: the default generic "Step Results" table (one
 * row per step, flattened outputs) used when config.sections is omitted,
 * and a declarative custom layout (config.sections) that replaces it —
 * see renderConfluenceStorageFormat below.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';

// ---------- Config types ----------------------------------------------------

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
  /** Dot-paths (per item) to extract, with display labels. Omit to use every own-enumerable key. */
  fields?: { label: string; field: string }[];
}

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
  /** Optional custom report layout. Omitted/empty = today's exact behavior. */
  sections?: ReportSection[];
}

export interface ConsolidatedStepEntry {
  stepName: string;
  ok: boolean;
  outputs: Record<string, unknown>;
  data?: unknown;
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

// ---------- Field path resolution --------------------------------------------

export function resolveFieldPath(obj: unknown, fieldPath: string): unknown {
  let cur: unknown = obj;
  for (const part of fieldPath.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------- Nested cell rendering (object/array values inside a cell) --------

function renderNestedValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `<ul>${value.map(item => `<li>${renderNestedValue(item)}</li>`).join('')}</ul>`;
  }
  if (isPlainObject(value)) {
    return `<ul>${Object.entries(value).map(([k, v]) => `<li>${escapeXhtml(k)}: ${renderNestedValue(v)}</li>`).join('')}</ul>`;
  }
  return escapeXhtml(value);
}

function renderCell(value: unknown): string {
  if (Array.isArray(value) || isPlainObject(value)) return renderNestedValue(value);
  return escapeXhtml(value);
}

// ---------- Section layout renderers -----------------------------------------

function fieldEntries(
  item: unknown,
  fields: { label: string; field: string }[] | undefined,
): Array<readonly [string, unknown]> {
  if (fields) return fields.map(f => [f.label, resolveFieldPath(item, f.field)] as const);
  if (isPlainObject(item)) return Object.entries(item);
  return [];
}

function renderTableSection(section: ReportSection, data: unknown): string {
  if (!Array.isArray(data)) {
    throw new Error(`section "${section.title}": table layout requires array data at "${section.arrayPath ?? '(root)'}"`);
  }
  const fields = section.fields
    ?? (data.length > 0 && isPlainObject(data[0]) ? Object.keys(data[0] as object).map(k => ({ label: k, field: k })) : []);
  const headerRow = `<tr>${fields.map(f => `<th>${escapeXhtml(f.label)}</th>`).join('')}</tr>`;
  const bodyRows = data
    .map(item => `<tr>${fields.map(f => `<td>${renderCell(resolveFieldPath(item, f.field))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}

function renderBulletsSection(section: ReportSection, data: unknown): string {
  if (Array.isArray(data)) {
    return data
      .map((item, i) => {
        const lines = fieldEntries(item, section.fields)
          .map(([label, v]) => `<li>${escapeXhtml(label)}: ${renderCell(v)}</li>`)
          .join('');
        return `<p><strong>Item ${i + 1}</strong></p><ul>${lines}</ul>`;
      })
      .join('');
  }
  if (isPlainObject(data)) {
    const lines = fieldEntries(data, section.fields)
      .map(([label, v]) => `<li>${escapeXhtml(label)}: ${renderCell(v)}</li>`)
      .join('');
    return `<ul>${lines}</ul>`;
  }
  throw new Error(`section "${section.title}": bullets layout requires array or object data`);
}

function renderKeyvalueSection(section: ReportSection, data: unknown): string {
  if (Array.isArray(data)) {
    throw new Error(`section "${section.title}": keyvalue layout requires object data, got an array — did you mean layout: "bullets"?`);
  }
  if (!isPlainObject(data)) {
    throw new Error(`section "${section.title}": keyvalue layout requires object data`);
  }
  const rows = fieldEntries(data, section.fields)
    .map(([label, v]) => `<tr><th>${escapeXhtml(label)}</th><td>${renderCell(v)}</td></tr>`)
    .join('');
  return `<table><tbody>${rows}</tbody></table>`;
}

function renderSection(section: ReportSection, result: ConsolidatedResult): string {
  const stepEntry = result.steps.find(s => s.stepName === section.dataFrom);
  if (!stepEntry) {
    throw new Error(`section "${section.title}": no step named "${section.dataFrom}" in the results`);
  }
  const source = section.source ?? 'outputs';
  const sourceValue = source === 'data' ? stepEntry.data : stepEntry.outputs;
  if (source === 'data' && sourceValue === undefined) {
    throw new Error(`section "${section.title}": step "${section.dataFrom}" has no embedded "data" (configure embedArtifacts in consolidate-run-results)`);
  }
  const data = section.arrayPath ? resolveFieldPath(sourceValue, section.arrayPath) : sourceValue;

  const layout = section.layout ?? 'keyvalue';
  const body = layout === 'table' ? renderTableSection(section, data)
    : layout === 'bullets' ? renderBulletsSection(section, data)
    : renderKeyvalueSection(section, data);

  return `<h2>${escapeXhtml(section.title)}</h2>${body}`;
}

// ---------- Content rendering ------------------------------------------------

export function renderConfluenceStorageFormat(result: ConsolidatedResult, sections?: ReportSection[]): string {
  const metadataRows = Object.entries(result.runMetadata)
    .map(([k, v]) => `<tr><th>${escapeXhtml(k)}</th><td>${escapeXhtml(v)}</td></tr>`)
    .join('');

  const summaryTable = `<h2>Run Summary</h2>
<table><tbody>
${metadataRows}
<tr><th>Generated At</th><td>${escapeXhtml(result.generatedAt)}</td></tr>
<tr><th>Total Steps</th><td>${result.summary.totalSteps}</td></tr>
<tr><th>Succeeded</th><td>${result.summary.succeededCount}</td></tr>
<tr><th>Failed</th><td>${result.summary.failedCount}</td></tr>
</tbody></table>`;

  if (sections && sections.length > 0) {
    const customSections = sections.map(section => renderSection(section, result)).join('\n');
    return `${summaryTable}\n${customSections}`;
  }

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

  return `${summaryTable}
<h2>Step Results</h2>
<table><thead><tr><th>Step</th><th>Status</th><th>Outputs</th></tr></thead><tbody>
${stepRows}
</tbody></table>`;
}

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

  const content = renderConfluenceStorageFormat(result, config.sections);
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

- [ ] **Step 2: Append these 15 tests to the end of `steps/publish-to-confluence.test.ts`**

```ts
test('resolveFieldPath resolves a nested dot-path', () => {
  assert.equal(resolveFieldPath({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
});

test('resolveFieldPath returns undefined for a missing path segment', () => {
  assert.equal(resolveFieldPath({ a: { b: 1 } }, 'a.x.y'), undefined);
  assert.equal(resolveFieldPath(null, 'a.b'), undefined);
});

function resultWithStep(
  stepName: string,
  overrides: Partial<{ ok: boolean; outputs: Record<string, unknown>; data: unknown; error: string }> = {},
) {
  return {
    runMetadata: {},
    generatedAt: 't',
    steps: [{
      stepName,
      ok: overrides.ok ?? true,
      outputs: overrides.outputs ?? {},
      data: overrides.data,
      error: overrides.error,
    }],
    summary: { totalSteps: 1, succeededCount: 1, failedCount: 0 },
  };
}

test('renderConfluenceStorageFormat renders a custom table section from embedded step data', () => {
  const result = resultWithStep('extractAdfDetails', {
    data: { pipelineRuns: [{ pipelineName: 'CopyOrders', runId: 'run-1', status: 'Succeeded', durationMs: 5000 }] },
  });
  const sections = [{
    title: 'ADF Pipeline Runs',
    dataFrom: 'extractAdfDetails',
    source: 'data' as const,
    arrayPath: 'pipelineRuns',
    layout: 'table' as const,
    fields: [
      { label: 'Pipeline', field: 'pipelineName' },
      { label: 'Run ID', field: 'runId' },
      { label: 'Status', field: 'status' },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h2>ADF Pipeline Runs<\/h2>/);
  assert.match(html, /<th>Pipeline<\/th>/);
  assert.match(html, /<td>CopyOrders<\/td>/);
  assert.match(html, /<td>run-1<\/td>/);
  assert.match(html, /<td>Succeeded<\/td>/);
  assert.doesNotMatch(html, /Step Results/);
});

test("renderConfluenceStorageFormat table layout falls back to the first item's own keys when fields is omitted", () => {
  const result = resultWithStep('a', { data: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
  const sections = [{ title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'table' as const }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<th>x<\/th><th>y<\/th>/);
  assert.match(html, /<td>1<\/td><td>2<\/td>/);
  assert.match(html, /<td>3<\/td><td>4<\/td>/);
});

test('renderConfluenceStorageFormat table layout throws when the resolved data is not an array', () => {
  const result = resultWithStep('a', { data: { notAnArray: true } });
  const sections = [{ title: 'Bad', dataFrom: 'a', source: 'data' as const, layout: 'table' as const }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /table layout requires array data/);
});

test('renderConfluenceStorageFormat renders nested bullets inside a table cell for an object field value', () => {
  const result = resultWithStep('a', { data: [{ name: 'x', details: { foo: 1, bar: 2 } }] });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'table' as const,
    fields: [{ label: 'Name', field: 'name' }, { label: 'Details', field: 'details' }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td><ul><li>foo: 1<\/li><li>bar: 2<\/li><\/ul><\/td>/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test('renderConfluenceStorageFormat renders nested bullets inside a table cell for an array field value', () => {
  const result = resultWithStep('a', { data: [{ name: 'x', tags: ['a', 'b'] }] });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'table' as const,
    fields: [{ label: 'Name', field: 'name' }, { label: 'Tags', field: 'tags' }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td><ul><li>a<\/li><li>b<\/li><\/ul><\/td>/);
});

test('renderConfluenceStorageFormat bullets layout renders each array item under an "Item N" heading', () => {
  const result = resultWithStep('a', { data: [{ x: 1 }, { x: 2 }] });
  const sections = [{ title: 'B', dataFrom: 'a', source: 'data' as const, layout: 'bullets' as const }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<strong>Item 1<\/strong>/);
  assert.match(html, /<strong>Item 2<\/strong>/);
  assert.match(html, /<li>x: 1<\/li>/);
  assert.match(html, /<li>x: 2<\/li>/);
});

test('renderConfluenceStorageFormat bullets layout renders a flat list for object data', () => {
  const result = resultWithStep('a', { outputs: { foo: 'bar', count: 3 } });
  const sections = [{ title: 'B', dataFrom: 'a', layout: 'bullets' as const }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<li>foo: bar<\/li>/);
  assert.match(html, /<li>count: 3<\/li>/);
  assert.doesNotMatch(html, /Item 1/);
});

test('renderConfluenceStorageFormat keyvalue layout renders a two-column table', () => {
  const result = resultWithStep('a', { outputs: { foo: 'bar' } });
  const sections = [{ title: 'K', dataFrom: 'a', layout: 'keyvalue' as const }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<th>foo<\/th><td>bar<\/td>/);
});

test('renderConfluenceStorageFormat keyvalue layout throws when data is an array', () => {
  const result = resultWithStep('a', { data: [1, 2] });
  const sections = [{ title: 'K', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /keyvalue layout requires object data[\s\S]*bullets/);
});

test("renderConfluenceStorageFormat throws when a section's dataFrom step is not present", () => {
  const result = resultWithStep('a');
  const sections = [{ title: 'X', dataFrom: 'missingStep' }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /no step named "missingStep"/);
});

test('renderConfluenceStorageFormat throws when source:"data" is requested but the step has no data', () => {
  const result = resultWithStep('a');
  const sections = [{ title: 'X', dataFrom: 'a', source: 'data' as const }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /has no embedded "data"/);
});

test('renderConfluenceStorageFormat falls back to the generic Step Results table when sections is an empty array', () => {
  const result = resultWithStep('a', { outputs: { foo: 'bar' } });
  const html = renderConfluenceStorageFormat(result, []);
  assert.match(html, /Step Results/);
});

test('runAll renders custom sections end to end when config.sections is set', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-test-'));
  try {
    const filePath = path.join(outDir, 'run-results.json');
    fs.writeFileSync(filePath, JSON.stringify({
      runMetadata: {},
      generatedAt: 't',
      steps: [{
        stepName: 'extractAdfDetails',
        ok: true,
        outputs: {},
        data: { pipelineRuns: [{ pipelineName: 'CopyOrders', runId: 'run-1', status: 'Succeeded' }] },
      }],
      summary: { totalSteps: 1, succeededCount: 1, failedCount: 0 },
    }));
    const fetchImpl: FetchLike = async url => {
      if (url.includes('spaceKey=')) return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({ id: 'new-1', _links: { webui: '/x' } }), text: async () => '' };
    };
    const config = {
      baseUrl: 'https://example.atlassian.net/wiki', email: 'e', apiToken: 't',
      spaceKey: 'ENG', pageTitle: 'Status', resultsPath: filePath,
      sections: [{
        title: 'ADF Pipeline Runs', dataFrom: 'extractAdfDetails', source: 'data' as const,
        arrayPath: 'pipelineRuns', layout: 'table' as const,
        fields: [{ label: 'Pipeline', field: 'pipelineName' }, { label: 'Run ID', field: 'runId' }],
      }],
    };
    await runAll(config, fakeCtx(outDir), fetchImpl);
    const content = fs.readFileSync(path.join(outDir, 'confluence-page-content.html'), 'utf8');
    assert.match(content, /<h2>ADF Pipeline Runs<\/h2>/);
    assert.match(content, /<td>CopyOrders<\/td>/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

Note: `resolveFieldPath` must be added to this file's existing `import { escapeXhtml, renderConfluenceStorageFormat } from './publish-to-confluence';` line at the top of the test file (add it to that same import). `fs`, `os`, `path`, `fakeCtx`, and `FetchLike` are already available in this file (imported/defined earlier, before the existing `runAll` tests) — do not add duplicates.

- [ ] **Step 3: Run the tests**

Run: `npx tsx --test steps/publish-to-confluence.test.ts`
Expected: all 31 tests pass (16 existing + 15 new).

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "feat: add declarative sections config to publish-to-confluence for custom report layouts"
```

---

### Task 3: Wire a real example into the pipeline configs and README

**Files:**
- Modify: `configs/consolidate-run-results.json`
- Modify: `configs/publish-to-confluence.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ConsolidateRunResultsConfig.embedArtifacts` (Task 1), `PublishToConfluenceConfig.sections` (Task 2).

- [ ] **Step 1: Add `embedArtifacts` to `configs/consolidate-run-results.json`**

Read the current file and add an `"embedArtifacts"` key after `"stepNames"`, so the file becomes:

```json
{
  "stepNames": [
    "genUsersCsv",
    "gpgEncryptCsv",
    "waitForTrigger",
    "executeAdf",
    "pollAdf",
    "extractAdfDetails",
    "verifyResult",
    "verifyRowCount",
    "validateSchema",
    "validateBusinessLogic"
  ],
  "embedArtifacts": {
    "extractAdfDetails": "adf-run-details.json"
  },
  "runMetadata": {
    "buildId": "{{env.BUILD_BUILDID}}",
    "branch": "{{env.BUILD_SOURCEBRANCH}}"
  }
}
```

- [ ] **Step 2: Add `sections` to `configs/publish-to-confluence.json`**

Read the current file and add a `"sections"` key, so the file becomes:

```json
{
  "baseUrl": "https://yoursite.atlassian.net/wiki",
  "email": "{{env.CONFLUENCE_EMAIL}}",
  "apiToken": "{{env.CONFLUENCE_API_TOKEN}}",
  "spaceKey": "ENG",
  "pageTitle": "Pipeline Run Status",
  "resultsPath": "{{env.PIPELINE_WORKSPACE}}/step-output-final/consolidateResults/run-results.json",
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

- [ ] **Step 3: Update `README.md`**

In the `## Running` section, replace this block (currently around line 131-139):

```
Consolidate run results (reads `ctx.steps`, so it must run after the steps
it names — no external auth needed):

```bash
npx tsx runner/run-step.ts \
  --step steps/consolidate-run-results.ts \
  --config configs/consolidate-run-results.json \
  --name consolidateResults
```
```

with:

```
Consolidate run results (reads `ctx.steps`, so it must run after the steps
it names — no external auth needed). `embedArtifacts` optionally embeds a
named step's full JSON artifact (not just its flat outputs) under that
step's `data` field — e.g. `extract-adf-run-details`'s pipeline-run and
activity detail, which otherwise never leaves that step's own artifact
file:

```bash
npx tsx runner/run-step.ts \
  --step steps/consolidate-run-results.ts \
  --config configs/consolidate-run-results.json \
  --name consolidateResults
```
```

Then, in the same section, replace the `Publish to Confluence` block (currently around line 141-151):

```
Publish to Confluence (needs `CONFLUENCE_EMAIL`/`CONFLUENCE_API_TOKEN`, and
a `run-results.json` already produced by `consolidate-run-results`):

```bash
export CONFLUENCE_EMAIL="you@example.com"
export CONFLUENCE_API_TOKEN="..."
npx tsx runner/run-step.ts \
  --step steps/publish-to-confluence.ts \
  --config configs/publish-to-confluence.json \
  --name publishConfluence
```
```

with:

```
Publish to Confluence (needs `CONFLUENCE_EMAIL`/`CONFLUENCE_API_TOKEN`, and
a `run-results.json` already produced by `consolidate-run-results`). The
optional `sections` config controls report layout per step — `table`
(explicit columns, one row per array item), `bullets` (one heading + list
per array item, or a flat list for a single object), or `keyvalue` (a
two-column table, the default when `sections` is omitted entirely). A
table/bullets/keyvalue cell whose value is itself an object or array
renders as a nested bullet list automatically:

```bash
export CONFLUENCE_EMAIL="you@example.com"
export CONFLUENCE_API_TOKEN="..."
npx tsx runner/run-step.ts \
  --step steps/publish-to-confluence.ts \
  --config configs/publish-to-confluence.json \
  --name publishConfluence
```
```

- [ ] **Step 4: Run the full test suite and type-check**

Run: `npm test && npm run typecheck`
Expected: all tests pass (161 total: 141 existing + 5 from Task 1 + 15 from Task 2 — Task 3 adds no new tests, only config/README changes), no typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add configs/consolidate-run-results.json configs/publish-to-confluence.json README.md
git commit -m "feat: wire embedArtifacts and sections into the real ADF reporting config, document both"
```

## Self-Review Notes

- Spec coverage: `embedArtifacts` (Task 1), `sections` config with all three layouts + nested cell bullets (Task 2), real-config wiring + README (Task 3) — all design sections covered.
- No placeholders: every step contains complete, runnable code and exact before/after text for the README edits.
- Type consistency checked: `ConsolidatedStepEntry.data?: unknown` is added identically (by convention, not import) in both `consolidate-run-results.ts` (Task 1) and `publish-to-confluence.ts`'s own local copy (Task 2); `ReportSection`'s field names (`dataFrom`, `source`, `arrayPath`, `layout`, `fields`) are used consistently between the type definition and every render function and test in Task 2; Task 3's example config's `dataFrom: "extractAdfDetails"` and `arrayPath` values match the field names `extract-adf-run-details.ts` actually writes into its `adf-run-details.json` artifact (`pipelineRuns`, `activities`, each with `pipelineName`/`runId`/`status`/`runStart`/`durationMs` or `activityName`/`activityId`/`status`/`activityRunStart`/`durationMs`).
