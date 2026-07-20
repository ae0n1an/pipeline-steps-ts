import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { escapeXhtml, renderConfluenceStorageFormat } from './publish-to-confluence';
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
