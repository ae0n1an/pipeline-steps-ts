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

export interface ReportField {
  label: string;
  field: string;
  /** Omit to render the raw (escaped) value, exactly as today. */
  format?: 'timestamp-aest' | 'duration-s' | 'bytes' | 'status' | 'number';
  /** Decimal places for 'bytes' | 'number' | 'duration-s'. Default 1 (0 for 'number'). Ignored by 'timestamp-aest' and 'status'. */
  decimals?: number;
}

export interface GanttConfig {
  taskField: string;
  startField: string;
  /** Duration in ms; used only if endField is absent on an item. */
  durationField?: string;
  /** ISO timestamp; takes precedence over durationField if both resolve. */
  endField?: string;
  /** Dot-path; groups bars into separate Mermaid `section` blocks, in order of first appearance. */
  sectionField?: string;
}

export interface ReportSection {
  /** Default 'data'. 'static' ignores every other data-section field below except title/html. */
  type?: 'data' | 'static';
  title: string;
  /** Step name, matching ConsolidatedStepEntry.stepName in the results JSON. Required unless type: 'static'. */
  dataFrom?: string;
  /** Which part of that step's entry to read. Default 'outputs'. */
  source?: 'outputs' | 'data';
  /** Dot-path within the selected source to the array or object to render. Omit to use the whole source value as-is. */
  arrayPath?: string;
  /** Default 'keyvalue'. */
  layout?: 'table' | 'bullets' | 'keyvalue' | 'gantt';
  /** Dot-paths (per item) to extract, with display labels. Omit to use every own-enumerable key. */
  fields?: ReportField[];
  /** Dot-path; splits array data into one <h3> sub-heading + table/bullets per distinct value, in order of first appearance. Only valid with layout 'table' or 'bullets'. */
  groupBy?: string;
  /** Required when layout is 'gantt'. */
  gantt?: GanttConfig;
  /** Required when type is 'static'. Raw Confluence storage-format content, inserted unescaped under <h2>{title}</h2>. */
  html?: string;
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
  /** Inserts Confluence's native Table of Contents macro as the very first element on the page. Default false. */
  includeToc?: boolean;
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

// ---------- Field formatters --------------------------------------------------

const KNOWN_FORMATS = new Set<string>(['duration-s', 'bytes', 'number', 'timestamp-aest', 'status']);

function formatBytes(bytes: number, decimals: number): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatTimestampAest(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${get('timeZoneName')}`;
}


const STATUS_LOZENGE_COLORS: Record<string, string> = {
  Succeeded: 'Green',
  Failed: 'Red',
  InProgress: 'Blue',
  Queued: 'Blue',
};

function formatStatusLozenge(value: unknown): string {
  const text = value == null ? '' : String(value);
  const colour = STATUS_LOZENGE_COLORS[text] ?? 'Grey';
  return `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${colour}</ac:parameter><ac:parameter ac:name="title">${escapeXhtml(text)}</ac:parameter></ac:structured-macro>`;
}

function formatValue(value: unknown, format: string, decimals?: number): string {
  switch (format) {
    case 'duration-s':
      return `${(Number(value) / 1000).toFixed(decimals ?? 1)}s`;
    case 'bytes':
      return formatBytes(Number(value), decimals ?? 1);
    case 'number':
      return Number(value).toFixed(decimals ?? 0);
    case 'timestamp-aest':
      return formatTimestampAest(value);
    case 'status':
      return formatStatusLozenge(value);
    default:
      // Unreachable in practice: callers only invoke this after checking
      // KNOWN_FORMATS. Kept as a safe fallback rather than throwing here,
      // since the caller already produces the user-facing error message.
      return escapeXhtml(value);
  }
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

interface ResolvedField {
  label: string;
  value: unknown;
  field: ReportField;
}

function fieldEntries(item: unknown, fields: ReportField[] | undefined): ResolvedField[] {
  if (fields) return fields.map(f => ({ label: f.label, value: resolveFieldPath(item, f.field), field: f }));
  if (isPlainObject(item)) return Object.entries(item).map(([label, value]) => ({ label, value, field: { label, field: label } }));
  return [];
}

function renderFieldValue(value: unknown, field: ReportField, sectionTitle: string): string {
  if (Array.isArray(value) || isPlainObject(value)) return renderCell(value);
  if (field.format) {
    if (!KNOWN_FORMATS.has(field.format)) {
      throw new Error(`section "${sectionTitle}": unknown format "${field.format}" for field "${field.field}"`);
    }
    return formatValue(value, field.format, field.decimals);
  }
  return escapeXhtml(value);
}

function renderTableSection(section: ReportSection, data: unknown): string {
  if (!Array.isArray(data)) {
    throw new Error(`section "${section.title}": table layout requires array data at "${section.arrayPath ?? '(root)'}"`);
  }
  const fields: ReportField[] = section.fields
    ?? (data.length > 0 && isPlainObject(data[0]) ? Object.keys(data[0] as object).map(k => ({ label: k, field: k })) : []);
  const headerRow = `<tr>${fields.map(f => `<th>${escapeXhtml(f.label)}</th>`).join('')}</tr>`;
  const bodyRows = data
    .map(item => `<tr>${fields.map(f => `<td>${renderFieldValue(resolveFieldPath(item, f.field), f, section.title)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}

function renderBulletsSection(section: ReportSection, data: unknown): string {
  if (Array.isArray(data)) {
    return data
      .map((item, i) => {
        const lines = fieldEntries(item, section.fields)
          .map(({ label, value, field }) => `<li>${escapeXhtml(label)}: ${renderFieldValue(value, field, section.title)}</li>`)
          .join('');
        return `<p><strong>Item ${i + 1}</strong></p><ul>${lines}</ul>`;
      })
      .join('');
  }
  if (isPlainObject(data)) {
    const lines = fieldEntries(data, section.fields)
      .map(({ label, value, field }) => `<li>${escapeXhtml(label)}: ${renderFieldValue(value, field, section.title)}</li>`)
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
    .map(({ label, value, field }) => `<tr><th>${escapeXhtml(label)}</th><td>${renderFieldValue(value, field, section.title)}</td></tr>`)
    .join('');
  return `<table><tbody>${rows}</tbody></table>`;
}

function partitionByKey<T>(items: T[], keyFn: (item: T) => string): Array<{ key: string; items: T[] }> {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(item);
  }
  return order.map(key => ({ key, items: map.get(key)! }));
}

function sanitizeMermaidText(value: unknown): string {
  return String(value ?? '').replace(/:/g, '');
}

function toMermaidTimestamp(date: Date): string {
  return date.toISOString().replace(/Z$/, '');
}

function resolveGanttEnd(item: unknown, gantt: GanttConfig, index: number, sectionTitle: string): string {
  const endRaw = gantt.endField ? resolveFieldPath(item, gantt.endField) : undefined;
  if (endRaw != null) return toMermaidTimestamp(new Date(String(endRaw)));
  const startRaw = resolveFieldPath(item, gantt.startField);
  const durationRaw = gantt.durationField ? resolveFieldPath(item, gantt.durationField) : undefined;
  if (startRaw != null && durationRaw != null) {
    return toMermaidTimestamp(new Date(new Date(String(startRaw)).getTime() + Number(durationRaw)));
  }
  throw new Error(`section "${sectionTitle}": item ${index + 1} has no resolvable end time (need endField or durationField)`);
}

function renderGanttSection(section: ReportSection, data: unknown): string {
  const gantt = section.gantt;
  if (!gantt || !gantt.taskField || !gantt.startField) {
    throw new Error(`section "${section.title}": gantt layout requires gantt.taskField and gantt.startField`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`section "${section.title}": gantt layout requires array data`);
  }

  const bars = data.map((item, index) => {
    const sectionKey = gantt.sectionField ? String(resolveFieldPath(item, gantt.sectionField) ?? '') : 'Activities';
    const taskName = sanitizeMermaidText(resolveFieldPath(item, gantt.taskField));
    const start = toMermaidTimestamp(new Date(String(resolveFieldPath(item, gantt.startField))));
    const end = resolveGanttEnd(item, gantt, index, section.title);
    return { sectionKey, line: `    ${taskName} : ${start}, ${end}` };
  });

  const groups = partitionByKey(bars, bar => bar.sectionKey);
  const body = groups.flatMap(g => [`    section ${sanitizeMermaidText(g.key)}`, ...g.items.map(b => b.line)]);

  const mermaid = [
    'gantt',
    '    dateFormat  YYYY-MM-DDTHH:mm:ss.SSS',
    '    axisFormat  %H:%M:%S',
    `    title ${sanitizeMermaidText(section.title)}`,
    ...body,
  ].join('\n');

  return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter><ac:plain-text-body><![CDATA[\n${mermaid}\n]]></ac:plain-text-body></ac:structured-macro>`;
}

function renderSection(section: ReportSection, result: ConsolidatedResult): string {
  if (section.type === 'static') {
    if (!section.html) {
      throw new Error(`section "${section.title}": type "static" requires html`);
    }
    return `<h2>${escapeXhtml(section.title)}</h2>${section.html}`;
  }

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

  if (section.groupBy) {
    if (layout !== 'table' && layout !== 'bullets' && layout !== 'gantt') {
      throw new Error(`section "${section.title}": groupBy is not supported on layout "${layout}"`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`section "${section.title}": groupBy requires array data`);
    }
    const groupBy = section.groupBy;
    const groups = partitionByKey(data, item => String(resolveFieldPath(item, groupBy) ?? ''));
    const body = groups
      .map(({ key, items }) => {
        const groupBody = layout === 'table' ? renderTableSection(section, items)
          : layout === 'bullets' ? renderBulletsSection(section, items)
          : renderGanttSection({ ...section, title: `${section.title} — ${key}` }, items);
        return `<h3>${escapeXhtml(key)}</h3>${groupBody}`;
      })
      .join('');
    return `<h2>${escapeXhtml(section.title)}</h2>${body}`;
  }

  const body = layout === 'table' ? renderTableSection(section, data)
    : layout === 'bullets' ? renderBulletsSection(section, data)
    : layout === 'gantt' ? renderGanttSection(section, data)
    : renderKeyvalueSection(section, data);

  return `<h2>${escapeXhtml(section.title)}</h2>${body}`;
}

// ---------- Content rendering ------------------------------------------------

export function renderConfluenceStorageFormat(result: ConsolidatedResult, sections?: ReportSection[], includeToc?: boolean): string {
  const toc = includeToc ? '<ac:structured-macro ac:name="toc" />' : '';
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
    return `${toc}${summaryTable}\n${customSections}`;
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

  return `${toc}${summaryTable}
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

  const content = renderConfluenceStorageFormat(result, config.sections, config.includeToc);
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
