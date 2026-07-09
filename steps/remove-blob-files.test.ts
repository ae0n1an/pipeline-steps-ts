import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { globToRegExp, literalPrefix, runAll } from './remove-blob-files';
import { createFakeBlobStorageClient } from './lib/blob-client';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('globToRegExp: * matches within a path segment, ** matches across segments', () => {
  assert.equal(globToRegExp('inbound/*.csv').test('inbound/a.csv'), true);
  assert.equal(globToRegExp('inbound/*.csv').test('inbound/sub/a.csv'), false);
  assert.equal(globToRegExp('inbound/**/a.csv').test('inbound/x/y/a.csv'), true);
  assert.equal(globToRegExp('inbound/2026-*/*.gpg').test('inbound/2026-07-09/f.gpg'), true);
  assert.equal(globToRegExp('inbound/2026-*/*.gpg').test('inbound/2025-01-01/f.gpg'), false);
});

test('globToRegExp escapes regex-special characters literally', () => {
  assert.equal(globToRegExp('a.b+c').test('a.b+c'), true);
  assert.equal(globToRegExp('a.b+c').test('aXb+c'), false); // "." must be literal, not "any char"
});

test('literalPrefix returns the substring before the first wildcard', () => {
  assert.equal(literalPrefix('inbound/2026-*/*.gpg'), 'inbound/2026-');
  assert.equal(literalPrefix('inbound/exact.txt'), 'inbound/exact.txt');
  assert.equal(literalPrefix('*'), '');
});

test('runAll deletes only the blobs matching each pattern and reports counts', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmblob-test-'));
  try {
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'inbound/a.gpg', Buffer.from('a'));
    client.seed('c1', 'inbound/b.gpg', Buffer.from('b'));
    client.seed('c1', 'outbound/c.gpg', Buffer.from('c'));

    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      patterns: [{ name: 'cleanInbound', pattern: 'inbound/*.gpg' }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.totalPatterns, 1);
    assert.equal(result.outputs?.cleanInbound_matchedCount, 2);
    assert.equal(result.outputs?.cleanInbound_deletedCount, 2);
    assert.equal(await client.blobExists('c1', 'inbound/a.gpg'), false);
    assert.equal(await client.blobExists('c1', 'inbound/b.gpg'), false);
    assert.equal(await client.blobExists('c1', 'outbound/c.gpg'), true);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'delete-summary.json'), 'utf8'));
    assert.deepEqual(summary[0].deletedPaths.sort(), ['inbound/a.gpg', 'inbound/b.gpg']);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll reports zero matches without failing when a pattern matches nothing', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmblob-test-'));
  try {
    const client = createFakeBlobStorageClient();
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      patterns: [{ name: 'nothing', pattern: 'inbound/*.gpg' }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.nothing_matchedCount, 0);
    assert.equal(result.outputs?.nothing_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll processes multiple patterns concurrently; one failure does not block a sibling', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmblob-test-'));
  try {
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'ok/a.gpg', Buffer.from('a'));
    const config = {
      containerName: 'c1', // no top-level accountUrl default
      patterns: [
        { name: 'good', pattern: 'ok/*.gpg', accountUrl: 'https://acct.blob.core.windows.net' },
        { name: 'bad', pattern: '*.gpg' }, // no accountUrl anywhere -> resolveBlobTarget throws
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), () => client),
      /1\/2 pattern\(s\) failed to process[\s\S]*bad[\s\S]*Failed/,
    );
    assert.equal(await client.blobExists('c1', 'ok/a.gpg'), false);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws when config.patterns is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmblob-test-'));
  try {
    await assert.rejects(
      () => runAll({ patterns: [] }, fakeCtx(outDir), () => createFakeBlobStorageClient()),
      /config\.patterns must contain at least one pattern/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
