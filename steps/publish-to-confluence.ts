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
  outputs: Record<string, unknown>;
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
