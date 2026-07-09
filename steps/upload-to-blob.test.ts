import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './upload-to-blob';
import { createFakeBlobStorageClient } from './lib/blob-client';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('uploads a single named file and reports its blob path and size', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  try {
    const localPath = path.join(outDir, 'input.txt');
    fs.writeFileSync(localPath, 'hello');
    const client = createFakeBlobStorageClient();
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ name: 'payload', localPath, blobPath: 'inbound/payload.txt' }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.totalFiles, 1);
    assert.equal(result.outputs?.payload_blobPath, 'inbound/payload.txt');
    assert.equal(result.outputs?.payload_sizeBytes, 5);
    assert.equal(await client.blobExists('c1', 'inbound/payload.txt'), true);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('overwrites an existing blob by default', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  try {
    const localPath = path.join(outDir, 'input.txt');
    fs.writeFileSync(localPath, 'v2-longer');
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'inbound/payload.txt', Buffer.from('v1'));
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ localPath, blobPath: 'inbound/payload.txt' }],
    };
    const result = await runAll(config, fakeCtx(outDir), () => client);
    assert.equal(result.outputs?.f0_sizeBytes, 9);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails an entry when overwrite is false and the blob already exists', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  try {
    const localPath = path.join(outDir, 'input.txt');
    fs.writeFileSync(localPath, 'v2');
    const client = createFakeBlobStorageClient();
    client.seed('c1', 'inbound/payload.txt', Buffer.from('v1'));
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [{ name: 'payload', localPath, blobPath: 'inbound/payload.txt', overwrite: false }],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), () => client),
      /1\/1 file\(s\) failed to upload[\s\S]*payload[\s\S]*already exists/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('uploads multiple files concurrently; one failure does not block the other', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  try {
    const goodPath = path.join(outDir, 'good.txt');
    fs.writeFileSync(goodPath, 'ok');
    const client = createFakeBlobStorageClient();
    const config = {
      accountUrl: 'https://acct.blob.core.windows.net',
      containerName: 'c1',
      files: [
        { name: 'good', localPath: goodPath, blobPath: 'inbound/good.txt' },
        { name: 'bad', localPath: path.join(outDir, 'missing.txt'), blobPath: 'inbound/bad.txt' },
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), () => client),
      /1\/2 file\(s\) failed to upload[\s\S]*bad[\s\S]*not found/,
    );
    assert.equal(await client.blobExists('c1', 'inbound/good.txt'), true);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  try {
    await assert.rejects(
      () => runAll({ files: [] }, fakeCtx(outDir), () => createFakeBlobStorageClient()),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
