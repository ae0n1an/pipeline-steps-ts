/**
 * Shared Azure Blob Storage client helper for the blob-storage steps
 * (remove-blob-files, upload-to-blob, verify-and-download-blob).
 *
 * The one deliberate exception to this repo's "every step is a fully
 * standalone module" framing: three steps need identical
 * BlobServiceClient + DefaultAzureCredential setup, so it lives here once.
 *
 * createAzureBlobStorageClient() is the real implementation, used by each
 * step's default export. createFakeBlobStorageClient() is an in-memory
 * implementation of the same interface used by every step's tests — there
 * is no live Azure Storage account to test against in this environment.
 */

import * as fs from 'node:fs';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

export interface BlobEntry {
  name: string;
  lastModified?: Date;
  sizeBytes: number;
}

export interface BlobStorageClient {
  listBlobs(containerName: string, prefix?: string): AsyncIterable<BlobEntry>;
  blobExists(containerName: string, blobPath: string): Promise<boolean>;
  deleteBlob(containerName: string, blobPath: string): Promise<void>;
  uploadBlob(
    containerName: string,
    blobPath: string,
    localFilePath: string,
    overwrite: boolean,
  ): Promise<{ url: string; sizeBytes: number }>;
  downloadBlob(
    containerName: string,
    blobPath: string,
    localFilePath: string,
  ): Promise<{ sizeBytes: number }>;
}

// ---------- Target resolution ----------------------------------------------

export interface BlobTarget {
  accountUrl: string;
  containerName: string;
}

export function resolveBlobTarget(
  entry: { accountUrl?: string; containerName?: string },
  config: { accountUrl?: string; containerName?: string },
): BlobTarget {
  const accountUrl = entry.accountUrl ?? config.accountUrl;
  const containerName = entry.containerName ?? config.containerName;
  if (!accountUrl || !containerName) {
    throw new Error(
      'accountUrl and containerName must be set either per-entry or as top-level config defaults',
    );
  }
  return { accountUrl, containerName };
}

// ---------- Real Azure-backed implementation --------------------------------

export function createAzureBlobStorageClient(accountUrl: string): BlobStorageClient {
  const serviceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());

  return {
    async *listBlobs(containerName, prefix) {
      const containerClient = serviceClient.getContainerClient(containerName);
      for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        yield {
          name: blob.name,
          lastModified: blob.properties.lastModified,
          sizeBytes: blob.properties.contentLength ?? 0,
        };
      }
    },

    async blobExists(containerName, blobPath) {
      const blockBlobClient = serviceClient.getContainerClient(containerName).getBlockBlobClient(blobPath);
      return blockBlobClient.exists();
    },

    async deleteBlob(containerName, blobPath) {
      const blockBlobClient = serviceClient.getContainerClient(containerName).getBlockBlobClient(blobPath);
      await blockBlobClient.deleteIfExists();
    },

    async uploadBlob(containerName, blobPath, localFilePath, overwrite) {
      const blockBlobClient = serviceClient.getContainerClient(containerName).getBlockBlobClient(blobPath);
      try {
        await blockBlobClient.uploadFile(
          localFilePath,
          overwrite ? undefined : { conditions: { ifNoneMatch: '*' } },
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (!overwrite && statusCode === 409) {
          throw new Error(`Blob already exists: ${blobPath}`);
        }
        throw err;
      }
      const stats = fs.statSync(localFilePath);
      return { url: blockBlobClient.url, sizeBytes: stats.size };
    },

    async downloadBlob(containerName, blobPath, localFilePath) {
      const blockBlobClient = serviceClient.getContainerClient(containerName).getBlockBlobClient(blobPath);
      await blockBlobClient.downloadToFile(localFilePath);
      const stats = fs.statSync(localFilePath);
      return { sizeBytes: stats.size };
    },
  };
}

// ---------- Fake in-memory implementation (for tests) -----------------------

interface FakeBlobStorageClient extends BlobStorageClient {
  /** Test setup helper: seed a blob's content without going through uploadBlob. */
  seed(containerName: string, blobPath: string, content: Buffer): void;
}

export function createFakeBlobStorageClient(): FakeBlobStorageClient {
  const containers = new Map<string, Map<string, { content: Buffer; lastModified: Date }>>();

  function containerMap(containerName: string): Map<string, { content: Buffer; lastModified: Date }> {
    let map = containers.get(containerName);
    if (!map) {
      map = new Map();
      containers.set(containerName, map);
    }
    return map;
  }

  return {
    seed(containerName, blobPath, content) {
      containerMap(containerName).set(blobPath, { content, lastModified: new Date() });
    },

    async *listBlobs(containerName, prefix) {
      for (const [name, entry] of containerMap(containerName)) {
        if (!prefix || name.startsWith(prefix)) {
          yield { name, lastModified: entry.lastModified, sizeBytes: entry.content.length };
        }
      }
    },

    async blobExists(containerName, blobPath) {
      return containerMap(containerName).has(blobPath);
    },

    async deleteBlob(containerName, blobPath) {
      containerMap(containerName).delete(blobPath);
    },

    async uploadBlob(containerName, blobPath, localFilePath, overwrite) {
      const map = containerMap(containerName);
      if (!overwrite && map.has(blobPath)) {
        throw new Error(`Blob already exists: ${blobPath}`);
      }
      const content = fs.readFileSync(localFilePath);
      map.set(blobPath, { content, lastModified: new Date() });
      return { url: `fake://${containerName}/${blobPath}`, sizeBytes: content.length };
    },

    async downloadBlob(containerName, blobPath, localFilePath) {
      const entry = containerMap(containerName).get(blobPath);
      if (!entry) throw new Error(`Blob not found: ${blobPath}`);
      fs.writeFileSync(localFilePath, entry.content);
      return { sizeBytes: entry.content.length };
    },
  };
}
