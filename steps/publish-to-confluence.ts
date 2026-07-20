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
