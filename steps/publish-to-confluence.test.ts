import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { escapeXhtml, renderConfluenceStorageFormat, resolveFieldPath } from './publish-to-confluence';
import { findExistingPage, createPage, updatePage, type FetchLike } from './publish-to-confluence';
import { runAll } from './publish-to-confluence';
import type { StepContext } from '../runner/types';

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

function resultWithSteps(
  entries: Array<{ stepName: string; outputs?: Record<string, unknown>; data?: unknown }>,
) {
  return {
    runMetadata: {},
    generatedAt: 't',
    steps: entries.map(e => ({
      stepName: e.stepName,
      ok: true,
      outputs: e.outputs ?? {},
      data: e.data,
    })),
    summary: { totalSteps: entries.length, succeededCount: entries.length, failedCount: 0 },
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

test('renderConfluenceStorageFormat formats a field with format:"duration-s"', () => {
  const result = resultWithStep('a', { data: { durationMs: 4200 } });
  const sections = [{
    title: 'D', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Duration', field: 'durationMs', format: 'duration-s' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<th>Duration<\/th><td>4\.2s<\/td>/);
});

test('renderConfluenceStorageFormat "duration-s" respects a custom decimals count', () => {
  const result = resultWithStep('a', { data: { durationMs: 4234 } });
  const sections = [{
    title: 'D', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Duration', field: 'durationMs', format: 'duration-s' as const, decimals: 0 }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>4s<\/td>/);
});

test('renderConfluenceStorageFormat formats a field with format:"bytes", auto-scaling to the largest unit', () => {
  const result = resultWithStep('a', { data: { size: 4404019 } });
  const sections = [{
    title: 'S', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Size', field: 'size', format: 'bytes' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>4\.2 MB<\/td>/);
});

test('renderConfluenceStorageFormat "bytes" keeps small values in bytes', () => {
  const result = resultWithStep('a', { data: { size: 512 } });
  const sections = [{
    title: 'S', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Size', field: 'size', format: 'bytes' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>512\.0 B<\/td>/);
});

test('renderConfluenceStorageFormat formats a field with format:"number" and decimals', () => {
  const result = resultWithStep('a', { data: { ratio: 0.98765 } });
  const sections = [{
    title: 'N', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Ratio', field: 'ratio', format: 'number' as const, decimals: 2 }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>0\.99<\/td>/);
});

test('renderConfluenceStorageFormat throws for an unrecognized format value', () => {
  const result = resultWithStep('a', { data: { x: 1 } });
  const sections = [{
    title: 'X', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'X', field: 'x', format: 'not-a-format' as any }],
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /unknown format "not-a-format" for field "x"/);
});

test('renderConfluenceStorageFormat leaves unformatted fields exactly as before', () => {
  const result = resultWithStep('a', { data: { name: 'plain' } });
  const sections = [{
    title: 'P', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Name', field: 'name' }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>plain<\/td>/);
});

test('renderConfluenceStorageFormat formats format:"timestamp-aest" in AEST (winter, UTC+10)', () => {
  const result = resultWithStep('a', { data: { runStart: '2026-07-21T04:32:05.000Z' } });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Start', field: 'runStart', format: 'timestamp-aest' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>2026-07-21 14:32:05 AEST<\/td>/);
});

test('renderConfluenceStorageFormat formats format:"timestamp-aest" in AEDT (summer, UTC+11)', () => {
  const result = resultWithStep('a', { data: { runStart: '2026-01-15T04:32:05.000Z' } });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Start', field: 'runStart', format: 'timestamp-aest' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>2026-01-15 15:32:05 AEDT<\/td>/);
});

test('renderConfluenceStorageFormat "timestamp-aest" crosses the DST boundary correctly', () => {
  const result = resultWithStep('a', {
    data: { before: '2026-04-04T15:59:00.000Z', after: '2026-04-04T16:01:00.000Z' },
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [
      { label: 'Before', field: 'before', format: 'timestamp-aest' as const },
      { label: 'After', field: 'after', format: 'timestamp-aest' as const },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>2026-04-05 02:59:00 AEDT<\/td>/);
  assert.match(html, /<td>2026-04-05 02:01:00 AEST<\/td>/);
});


test('renderConfluenceStorageFormat formats format:"status" as a colored status lozenge macro', () => {
  const result = resultWithStep('a', { data: { status: 'Succeeded' } });
  const sections = [{
    title: 'St', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Status', field: 'status', format: 'status' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(
    html,
    /<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green<\/ac:parameter><ac:parameter ac:name="title">Succeeded<\/ac:parameter><\/ac:structured-macro>/,
  );
});

test('renderConfluenceStorageFormat "status" maps Failed to Red and escapes an unrecognized value mapped to Grey', () => {
  const result = resultWithStep('a', { data: { a: 'Failed', b: 'Weird<Value>' } });
  const sections = [{
    title: 'St', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [
      { label: 'A', field: 'a', format: 'status' as const },
      { label: 'B', field: 'b', format: 'status' as const },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /colour">Red<\/ac:parameter><ac:parameter ac:name="title">Failed/);
  assert.match(html, /colour">Grey<\/ac:parameter><ac:parameter ac:name="title">Weird&lt;Value&gt;/);
});

test('renderConfluenceStorageFormat groupBy splits a table section into one sub-heading and table per group, in order of first appearance', () => {
  const result = resultWithStep('a', {
    data: [
      { parentRunId: 'p1', pipelineName: 'ChildA' },
      { parentRunId: 'p1', pipelineName: 'ChildB' },
      { parentRunId: 'p2', pipelineName: 'ChildC' },
    ],
  });
  const sections = [{
    title: 'Runs', dataFrom: 'a', source: 'data' as const, layout: 'table' as const, groupBy: 'parentRunId',
    fields: [{ label: 'Pipeline', field: 'pipelineName' }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h2>Runs<\/h2>/);
  assert.match(html, /<h3>p1<\/h3>/);
  assert.match(html, /<h3>p2<\/h3>/);
  assert.match(html, /<td>ChildA<\/td>/);
  assert.match(html, /<td>ChildC<\/td>/);
  const p1Index = html.indexOf('<h3>p1</h3>');
  const p2Index = html.indexOf('<h3>p2</h3>');
  const childCIndex = html.indexOf('<td>ChildC</td>');
  assert.ok(p1Index < p2Index);
  assert.ok(p2Index < childCIndex);
});

test('renderConfluenceStorageFormat groupBy also works with layout:"bullets"', () => {
  const result = resultWithStep('a', {
    data: [
      { parentRunId: 'p1', pipelineName: 'ChildA' },
      { parentRunId: 'p2', pipelineName: 'ChildC' },
    ],
  });
  const sections = [{
    title: 'Runs', dataFrom: 'a', source: 'data' as const, layout: 'bullets' as const, groupBy: 'parentRunId',
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h3>p1<\/h3>/);
  assert.match(html, /<h3>p2<\/h3>/);
  assert.match(html, /<li>pipelineName: ChildA<\/li>/);
});

test('renderConfluenceStorageFormat throws when groupBy is combined with layout:"keyvalue"', () => {
  const result = resultWithStep('a', { data: [{ x: 1 }] });
  const sections = [{
    title: 'G', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const, groupBy: 'x',
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /groupBy is not supported on layout "keyvalue"/);
});

test('renderConfluenceStorageFormat groupBy on layout:"gantt" renders one independent chart per group, in order of first appearance', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'A1', s: '2026-07-21T09:00:00.000Z', durationMs: 1000, topLevelRunId: 'run-1' },
      { name: 'B1', s: '2026-07-21T09:00:01.000Z', durationMs: 1000, topLevelRunId: 'run-2' },
      { name: 'A2', s: '2026-07-21T09:00:02.000Z', durationMs: 1000, topLevelRunId: 'run-1' },
    ],
  });
  const sections = [{
    title: 'Timeline', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const, groupBy: 'topLevelRunId',
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h2>Timeline<\/h2>/);
  assert.match(html, /<h3>run-1<\/h3>/);
  assert.match(html, /<h3>run-2<\/h3>/);
  assert.match(html, /title Timeline — run-1/);
  assert.match(html, /title Timeline — run-2/);
  const h3Run1 = html.indexOf('<h3>run-1</h3>');
  const h3Run2 = html.indexOf('<h3>run-2</h3>');
  const a1Index = html.indexOf('A1 :');
  const a2Index = html.indexOf('A2 :');
  const b1Index = html.indexOf('B1 :');
  assert.ok(h3Run1 < a1Index);
  assert.ok(a1Index < a2Index);
  assert.ok(a2Index < h3Run2);
  assert.ok(h3Run2 < b1Index);
  // Two independent code-block macros, one per group.
  const codeBlockCount = (html.match(/ac:name="code"/g) ?? []).length;
  assert.equal(codeBlockCount, 2);
});

test('renderConfluenceStorageFormat groupBy on layout:"gantt" still applies gantt.sectionField within each group\'s chart', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'A1', s: '2026-07-21T09:00:00.000Z', durationMs: 1000, topLevelRunId: 'run-1', childRunId: 'child-1' },
      { name: 'A2', s: '2026-07-21T09:00:01.000Z', durationMs: 1000, topLevelRunId: 'run-1', childRunId: 'child-2' },
      { name: 'B1', s: '2026-07-21T09:00:02.000Z', durationMs: 1000, topLevelRunId: 'run-2', childRunId: 'child-3' },
      { name: 'B2', s: '2026-07-21T09:00:03.000Z', durationMs: 1000, topLevelRunId: 'run-2', childRunId: 'child-4' },
    ],
  });
  const sections = [{
    title: 'Timeline', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const, groupBy: 'topLevelRunId',
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs', sectionField: 'childRunId' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  // Two separate <h3> group headings
  assert.match(html, /<h3>run-1<\/h3>/);
  assert.match(html, /<h3>run-2<\/h3>/);
  // Section names from both groups appear
  assert.match(html, /section child-1/);
  assert.match(html, /section child-2/);
  assert.match(html, /section child-3/);
  assert.match(html, /section child-4/);
  // Two separate Mermaid code-block macros (one per group)
  const codeBlockCount = (html.match(/ac:name="code"/g) ?? []).length;
  assert.equal(codeBlockCount, 2);
  // Each group's sections appear in the right place: run-2's sections come after run-2's heading
  const h3Run1 = html.indexOf('<h3>run-1</h3>');
  const h3Run2 = html.indexOf('<h3>run-2</h3>');
  const child3Index = html.indexOf('section child-3');
  const child1Index = html.indexOf('section child-1');
  assert.ok(h3Run1 < child1Index, 'run-1 heading should come before child-1 section');
  assert.ok(h3Run2 < child3Index, 'run-2 heading should come before child-3 section');
  assert.ok(child1Index < h3Run2, 'run-1 sections should come before run-2 heading');
  assert.ok(child3Index > h3Run2, 'run-2 sections should come after run-2 heading');
});

test('renderConfluenceStorageFormat groupBy on layout:"gantt" omits a group whose bars are entirely filtered out by minDurationS', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'TinyA', s: '2026-07-21T09:00:00.000Z', durationMs: 500, topLevelRunId: 'run-1' },
      { name: 'BigB', s: '2026-07-21T09:00:01.000Z', durationMs: 10000, topLevelRunId: 'run-2' },
    ],
  });
  const sections = [{
    title: 'Timeline', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const, groupBy: 'topLevelRunId',
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs', minDurationS: 5 },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.doesNotMatch(html, /<h3>run-1<\/h3>/);
  assert.match(html, /<h3>run-2<\/h3>/);
  assert.match(html, /BigB :/);
});

test('renderConfluenceStorageFormat throws when groupBy is used on non-array data', () => {
  const result = resultWithStep('a', { data: { notAnArray: true } });
  const sections = [{ title: 'G', dataFrom: 'a', source: 'data' as const, layout: 'table' as const, groupBy: 'x' }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /groupBy requires array data/);
});

test('renderConfluenceStorageFormat renders a gantt layout as a Mermaid code-block macro using durationField', () => {
  const result = resultWithStep('a', {
    data: [{ activityName: 'CopyData', activityRunStart: '2026-07-21T09:00:00.000Z', durationMs: 30000 }],
  });
  const sections = [{
    title: 'Timeline', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'activityName', startField: 'activityRunStart', durationField: 'durationMs' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid<\/ac:parameter>/);
  assert.match(html, /gantt/);
  assert.match(html, /section Activities/);
  assert.match(html, /CopyData : 2026-07-21T09:00:00\.000, 2026-07-21T09:00:30\.000/);
});

test('renderConfluenceStorageFormat gantt prefers endField over durationField when both resolve', () => {
  const result = resultWithStep('a', {
    data: [{ name: 'A', s: '2026-07-21T09:00:00.000Z', e: '2026-07-21T09:05:00.000Z', durationMs: 999 }],
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's', endField: 'e', durationField: 'durationMs' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /A : 2026-07-21T09:00:00\.000, 2026-07-21T09:05:00\.000/);
});

test('renderConfluenceStorageFormat gantt groups bars into Mermaid sections via sectionField, in order of first appearance', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'A1', s: '2026-07-21T09:00:00.000Z', durationMs: 1000, pipelineRunId: 'run-1' },
      { name: 'B1', s: '2026-07-21T09:00:01.000Z', durationMs: 1000, pipelineRunId: 'run-2' },
      { name: 'A2', s: '2026-07-21T09:00:02.000Z', durationMs: 1000, pipelineRunId: 'run-1' },
    ],
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs', sectionField: 'pipelineRunId' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  const run1Index = html.indexOf('section run-1');
  const run2Index = html.indexOf('section run-2');
  const a1Index = html.indexOf('A1 :');
  const a2Index = html.indexOf('A2 :');
  const b1Index = html.indexOf('B1 :');
  assert.ok(run1Index < a1Index);
  assert.ok(a1Index < a2Index);
  assert.ok(a2Index < run2Index);
  assert.ok(run2Index < b1Index);
});

test('renderConfluenceStorageFormat gantt strips colons from task names (Mermaid field separator)', () => {
  const result = resultWithStep('a', {
    data: [{ name: 'Copy: Orders', s: '2026-07-21T09:00:00.000Z', durationMs: 1000 }],
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /Copy Orders : /);
  assert.doesNotMatch(html, /Copy: Orders/);
});

test('renderConfluenceStorageFormat throws when gantt layout is missing gantt.taskField/startField', () => {
  const result = resultWithStep('a', { data: [{ x: 1 }] });
  const sections = [{ title: 'G', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /gantt layout requires gantt\.taskField and gantt\.startField/);
});

test('renderConfluenceStorageFormat throws when a gantt item has no resolvable end time', () => {
  const result = resultWithStep('a', { data: [{ name: 'A', s: '2026-07-21T09:00:00.000Z' }] });
  const sections = [{
    title: 'G', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's' },
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /item 1 has no resolvable end time/);
});

test('renderConfluenceStorageFormat renders a type:"static" section with raw, unescaped html', () => {
  const result = resultWithStep('a', {});
  const sections = [{ type: 'static' as const, title: 'Release Notes', html: '<p>Deployed by CI.</p>' }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h2>Release Notes<\/h2><p>Deployed by CI\.<\/p>/);
});

test('renderConfluenceStorageFormat throws when a type:"static" section has no html', () => {
  const result = resultWithStep('a', {});
  const sections = [{ type: 'static' as const, title: 'Notes' }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /type "static" requires html/);
});

test('renderConfluenceStorageFormat includes the Confluence TOC macro as the first element when includeToc is true', () => {
  const result = resultWithStep('a', { outputs: {} });
  const html = renderConfluenceStorageFormat(result, undefined, true);
  assert.ok(html.startsWith('<ac:structured-macro ac:name="toc" />'));
});

test('renderConfluenceStorageFormat omits the TOC macro when includeToc is false or omitted', () => {
  const result = resultWithStep('a', { outputs: {} });
  const html = renderConfluenceStorageFormat(result);
  assert.doesNotMatch(html, /ac:name="toc"/);
});

test('runAll renders a full page combining format, groupBy, gantt, static sections, and includeToc', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-test-'));
  try {
    const filePath = path.join(outDir, 'run-results.json');
    fs.writeFileSync(filePath, JSON.stringify({
      runMetadata: { buildId: '1' },
      generatedAt: 't',
      steps: [{
        stepName: 'extractAdfDetails',
        ok: true,
        outputs: {},
        data: {
          pipelineRuns: [
            { pipelineName: 'ChildA', parentRunId: 'p1', status: 'Succeeded', runStart: '2026-07-21T04:00:00.000Z', durationMs: 4200 },
            { pipelineName: 'ChildB', parentRunId: 'p2', status: 'Failed', runStart: '2026-07-21T04:05:00.000Z', durationMs: 1000 },
          ],
          activities: [
            { activityName: 'CopyData', activityRunStart: '2026-07-21T04:00:00.000Z', durationMs: 30000, pipelineRunId: 'p1' },
          ],
        },
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
      includeToc: true,
      sections: [
        { type: 'static' as const, title: 'Overview', html: '<p>Nightly ADF run.</p>' },
        {
          title: 'ADF Pipeline Runs', dataFrom: 'extractAdfDetails', source: 'data' as const,
          arrayPath: 'pipelineRuns', layout: 'table' as const, groupBy: 'parentRunId',
          fields: [
            { label: 'Pipeline', field: 'pipelineName' },
            { label: 'Status', field: 'status', format: 'status' as const },
            { label: 'Start', field: 'runStart', format: 'timestamp-aest' as const },
            { label: 'Duration', field: 'durationMs', format: 'duration-s' as const },
          ],
        },
        {
          title: 'ADF Activity Timeline', dataFrom: 'extractAdfDetails', source: 'data' as const,
          arrayPath: 'activities', layout: 'gantt' as const,
          gantt: { taskField: 'activityName', startField: 'activityRunStart', durationField: 'durationMs', sectionField: 'pipelineRunId' },
        },
      ],
    };
    await runAll(config, fakeCtx(outDir), fetchImpl);
    const content = fs.readFileSync(path.join(outDir, 'confluence-page-content.html'), 'utf8');
    assert.ok(content.startsWith('<ac:structured-macro ac:name="toc" />'));
    assert.match(content, /<h2>Overview<\/h2><p>Nightly ADF run\.<\/p>/);
    assert.match(content, /<h3>p1<\/h3>/);
    assert.match(content, /<h3>p2<\/h3>/);
    assert.match(content, /colour">Green/);
    assert.match(content, /colour">Red/);
    assert.match(content, /2026-07-21 14:00:00 AEST/);
    assert.match(content, /4\.2s/);
    assert.match(content, /language">mermaid/);
    assert.match(content, /CopyData : 2026-07-21T04:00:00\.000, 2026-07-21T04:00:30\.000/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('renderConfluenceStorageFormat join merges rows from two sources sharing a keyField, in order of first appearance', () => {
  const result = resultWithSteps([
    { stepName: 'inbound', data: [{ fileId: 'f1', path: 'a.csv', rows: 10 }, { fileId: 'f2', path: 'b.csv', rows: 20 }] },
    { stepName: 'outbound', data: [{ fileId: 'f2', size: 200 }, { fileId: 'f1', size: 100 }] },
  ]);
  const sections = [{
    title: 'Files', type: 'join' as const,
    join: [
      { dataFrom: 'inbound', source: 'data' as const, keyField: 'fileId', fields: [{ label: 'Path', field: 'path' }, { label: 'Rows', field: 'rows' }] },
      { dataFrom: 'outbound', source: 'data' as const, keyField: 'fileId', fields: [{ label: 'Size', field: 'size' }] },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h2>Files<\/h2>/);
  assert.match(html, /<th>Path<\/th><th>Rows<\/th><th>Size<\/th>/);
  assert.match(html, /<td>a\.csv<\/td><td>10<\/td><td>100<\/td>/);
  assert.match(html, /<td>b\.csv<\/td><td>20<\/td><td>200<\/td>/);
  const f1Index = html.indexOf('a.csv');
  const f2Index = html.indexOf('b.csv');
  assert.ok(f1Index < f2Index);
});

test('renderConfluenceStorageFormat join produces independent rows for sources with no keyField (union)', () => {
  const result = resultWithSteps([
    { stepName: 'inbound', data: [{ path: 'a.csv', rows: 10 }] },
    { stepName: 'outbound', data: [{ path: 'result.json', rows: 5 }] },
  ]);
  const sections = [{
    title: 'Files', type: 'join' as const,
    join: [
      { dataFrom: 'inbound', source: 'data' as const, fields: [{ label: 'Inbound Path', field: 'path' }, { label: 'Inbound Rows', field: 'rows' }] },
      { dataFrom: 'outbound', source: 'data' as const, fields: [{ label: 'Outbound Path', field: 'path' }, { label: 'Outbound Rows', field: 'rows' }] },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>a\.csv<\/td><td>10<\/td><td><\/td><td><\/td>/);
  assert.match(html, /<td><\/td><td><\/td><td>result\.json<\/td><td>5<\/td>/);
});

test('renderConfluenceStorageFormat join allows mixing a keyed source with an unkeyed source in the same section', () => {
  const result = resultWithSteps([
    { stepName: 'keyed', data: [{ id: 'k1', name: 'Alpha' }] },
    { stepName: 'unkeyed', data: [{ note: 'extra row' }] },
  ]);
  const sections = [{
    title: 'Mixed', type: 'join' as const,
    join: [
      { dataFrom: 'keyed', source: 'data' as const, keyField: 'id', fields: [{ label: 'Name', field: 'name' }] },
      { dataFrom: 'unkeyed', source: 'data' as const, fields: [{ label: 'Note', field: 'note' }] },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>Alpha<\/td><td><\/td>/);
  assert.match(html, /<td><\/td><td>extra row<\/td>/);
});

test("renderConfluenceStorageFormat join keeps two sources' same-labeled columns distinct (no collision)", () => {
  const result = resultWithSteps([
    { stepName: 'a', data: [{ path: 'in.csv' }] },
    { stepName: 'b', data: [{ path: 'out.json' }] },
  ]);
  const sections = [{
    title: 'T', type: 'join' as const,
    join: [
      { dataFrom: 'a', source: 'data' as const, fields: [{ label: 'Path', field: 'path' }] },
      { dataFrom: 'b', source: 'data' as const, fields: [{ label: 'Path', field: 'path' }] },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<th>Path<\/th><th>Path<\/th>/);
  assert.match(html, /<td>in\.csv<\/td><td><\/td>/);
  assert.match(html, /<td><\/td><td>out\.json<\/td>/);
});

test('renderConfluenceStorageFormat throws when type:"join" has no join array', () => {
  const result = resultWithSteps([{ stepName: 'a' }]);
  const sections = [{ title: 'T', type: 'join' as const }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /type "join" requires a non-empty "join" array/);
});

test('renderConfluenceStorageFormat throws when a join source names a step not present in the results', () => {
  const result = resultWithSteps([{ stepName: 'a', data: [] }]);
  const sections = [{
    title: 'T', type: 'join' as const,
    join: [{ dataFrom: 'missingStep', source: 'data' as const, fields: [{ label: 'X', field: 'x' }] }],
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /no step named "missingStep"/);
});

test('renderConfluenceStorageFormat throws when a join source resolves to non-array data', () => {
  const result = resultWithSteps([{ stepName: 'a', data: { notAnArray: true } }]);
  const sections = [{
    title: 'T', type: 'join' as const,
    join: [{ dataFrom: 'a', source: 'data' as const, fields: [{ label: 'X', field: 'x' }] }],
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /join source "a" requires array data/);
});

test('renderConfluenceStorageFormat gantt minDurationS drops bars shorter than the threshold (inclusive boundary)', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'Short', s: '2026-07-21T09:00:00.000Z', durationMs: 4000 },
      { name: 'Exact', s: '2026-07-21T09:00:05.000Z', durationMs: 5000 },
      { name: 'Long', s: '2026-07-21T09:00:10.000Z', durationMs: 10000 },
    ],
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs', minDurationS: 5 },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.doesNotMatch(html, /Short :/);
  assert.match(html, /Exact :/);
  assert.match(html, /Long :/);
});

test('renderConfluenceStorageFormat gantt minDurationS omits a sectionField group whose bars are all filtered out', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'TinyA', s: '2026-07-21T09:00:00.000Z', durationMs: 500, pipelineRunId: 'run-1' },
      { name: 'TinyB', s: '2026-07-21T09:00:01.000Z', durationMs: 500, pipelineRunId: 'run-1' },
      { name: 'BigC', s: '2026-07-21T09:00:02.000Z', durationMs: 10000, pipelineRunId: 'run-2' },
    ],
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs', sectionField: 'pipelineRunId', minDurationS: 5 },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.doesNotMatch(html, /section run-1/);
  assert.match(html, /section run-2/);
  assert.match(html, /BigC :/);
});
