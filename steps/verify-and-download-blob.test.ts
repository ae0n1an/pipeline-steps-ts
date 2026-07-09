import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './verify-and-download-blob';
import { createFakeBlobStorageClient } from './lib/blob-client';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('downloads an existing blob to the default local path derived from its basename', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  try {
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'outbound/report.json', Buffer.from('{"ok":true}'));
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ name: 'report', blobPath: 'outbound/report.json' }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.report_exists, true);
    const localPath = result.outputs?.report_localPath as string;
    assert.equal(localPath, path.join(outDir, 'report.json'));
    assert.equal(fs.readFileSync(localPath, 'utf8'), '{"ok":true}');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails by default when a required blob is missing', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  try {
    const client = createFakeBlobStorageClient();
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ name: 'missing', blobPath: 'outbound/missing.json' }],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), () => client),
      /1\/1 file\(s\) failed verification[\s\S]*missing[\s\S]*not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('does not fail when a missing blob is marked required: false, and records exists: false', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  try {
    const client = createFakeBlobStorageClient();
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ name: 'optional', blobPath: 'outbound/optional.json', required: false }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.optional_exists, false);
    assert.equal(result.outputs?.optional_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('a missing required file does not block a sibling from downloading successfully', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  try {
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'outbound/present.json', Buffer.from('{"a":1}'));
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [
        { name: 'present', blobPath: 'outbound/present.json' },
        { name: 'missing', blobPath: 'outbound/missing.json' },
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), () => client),
      /1\/2 file\(s\) failed verification[\s\S]*missing/,
    );
    assert.ok(fs.existsSync(path.join(outDir, 'present.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  try {
    await assert.rejects(
      () => runAll({ files: [] }, fakeCtx(outDir), () => createFakeBlobStorageClient()),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
