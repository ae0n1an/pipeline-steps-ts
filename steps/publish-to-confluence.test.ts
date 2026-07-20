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
