import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBlobTarget, createFakeBlobStorageClient } from './blob-client';

test('resolveBlobTarget uses per-entry fields when present', () => {
  const target = resolveBlobTarget(
    { accountUrl: 'https://a.blob.core.windows.net', containerName: 'c1' },
    {},
  );
  assert.deepEqual(target, { accountUrl: 'https://a.blob.core.windows.net', containerName: 'c1' });
});

test('resolveBlobTarget falls back to top-level config defaults', () => {
  const target = resolveBlobTarget(
    {},
    { accountUrl: 'https://a.blob.core.windows.net', containerName: 'c1' },
  );
  assert.deepEqual(target, { accountUrl: 'https://a.blob.core.windows.net', containerName: 'c1' });
});

test('resolveBlobTarget throws when a coordinate is missing everywhere', () => {
  assert.throws(
    () => resolveBlobTarget({ containerName: 'c1' }, {}),
    /accountUrl and containerName must be set/,
  );
});

test('listBlobs returns only seeded blobs matching the prefix', async () => {
  const client = createFakeBlobStorageClient();
  client.seed('c1', 'inbound/a.txt', Buffer.from('a'));
  client.seed('c1', 'inbound/b.txt', Buffer.from('b'));
  client.seed('c1', 'outbound/c.txt', Buffer.from('c'));

  const names: string[] = [];
  for await (const entry of client.listBlobs('c1', 'inbound/')) {
    names.push(entry.name);
  }
  assert.deepEqual(names.sort(), ['inbound/a.txt', 'inbound/b.txt']);
});

test('blobExists reflects seeded and unseeded blobs', async () => {
  const client = createFakeBlobStorageClient();
  client.seed('c1', 'a.txt', Buffer.from('a'));
  assert.equal(await client.blobExists('c1', 'a.txt'), true);
  assert.equal(await client.blobExists('c1', 'missing.txt'), false);
});

test('uploadBlob overwrites by default and rejects when overwrite is false and the blob exists', async () => {
  const client = createFakeBlobStorageClient();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-client-test-'));
  try {
    const localPath = path.join(tmpDir, 'input.txt');
    fs.writeFileSync(localPath, 'v1');
    const result1 = await client.uploadBlob('c1', 'a.txt', localPath, true);
    assert.equal(result1.sizeBytes, 2);

    fs.writeFileSync(localPath, 'v2-longer');
    const result2 = await client.uploadBlob('c1', 'a.txt', localPath, true);
    assert.equal(result2.sizeBytes, 9);

    await assert.rejects(
      () => client.uploadBlob('c1', 'a.txt', localPath, false),
      /already exists/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('downloadBlob writes the seeded content to a local file and throws for a missing blob', async () => {
  const client = createFakeBlobStorageClient();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-client-test-'));
  try {
    client.seed('c1', 'a.txt', Buffer.from('hello'));
    const localPath = path.join(tmpDir, 'out.txt');
    const result = await client.downloadBlob('c1', 'a.txt', localPath);
    assert.equal(result.sizeBytes, 5);
    assert.equal(fs.readFileSync(localPath, 'utf8'), 'hello');

    await assert.rejects(
      () => client.downloadBlob('c1', 'missing.txt', localPath),
      /not found/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('deleteBlob removes a seeded blob and is a no-op for a missing one', async () => {
  const client = createFakeBlobStorageClient();
  client.seed('c1', 'a.txt', Buffer.from('a'));
  await client.deleteBlob('c1', 'a.txt');
  assert.equal(await client.blobExists('c1', 'a.txt'), false);
  await client.deleteBlob('c1', 'missing.txt'); // does not throw
});
