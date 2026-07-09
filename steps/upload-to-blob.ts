/**
 * Step: upload-to-blob (TypeScript)
 *
 * Uploads one or more local files to Azure Blob Storage, e.g. encrypted
 * payloads from gpg-encrypt-file to an inbound container. Overwrites the
 * target blob by default; set overwrite: false to fail instead of
 * clobbering an existing blob. Files are processed concurrently; the step
 * waits for all files before deciding pass/fail and throws one aggregated
 * error if any file failed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import {
  createAzureBlobStorageClient,
  resolveBlobTarget,
  type BlobStorageClient,
} from './lib/blob-client';

export interface UploadEntry {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  localPath: string;
  blobPath: string;
  /** Overwrite an existing blob at blobPath; default true. */
  overwrite?: boolean;
  accountUrl?: string;
  containerName?: string;
}

export interface UploadToBlobConfig {
  accountUrl?: string;
  containerName?: string;
  files: UploadEntry[];
}

export interface UploadResult {
  name: string;
  blobPath: string;
  blobUrl?: string;
  sizeBytes: number;
  status: 'Succeeded' | 'Failed';
  message?: string;
}

async function runOneUpload(
  entry: UploadEntry,
  index: number,
  config: UploadToBlobConfig,
  clientFactory: (accountUrl: string) => BlobStorageClient,
  ctx: StepContext,
): Promise<UploadResult> {
  const name = entry.name ?? `f${index}`;
  try {
    if (!entry.localPath) throw new Error('localPath is required');
    if (!fs.existsSync(entry.localPath)) throw new Error(`Local file not found: ${entry.localPath}`);
    if (!entry.blobPath) throw new Error('blobPath is required');

    const target = resolveBlobTarget(entry, config);
    const client = clientFactory(target.accountUrl);
    const overwrite = entry.overwrite ?? true;

    const { url, sizeBytes } = await client.uploadBlob(target.containerName, entry.blobPath, entry.localPath, overwrite);
    ctx.log(`Uploaded "${entry.localPath}" -> "${entry.blobPath}" (${name})`);

    return { name, blobPath: entry.blobPath, blobUrl: url, sizeBytes, status: 'Succeeded' };
  } catch (err) {
    return {
      name,
      blobPath: entry.blobPath,
      sizeBytes: 0,
      status: 'Failed',
      message: (err as Error).message,
    };
  }
}

export async function runAll(
  config: UploadToBlobConfig,
  ctx: StepContext,
  clientFactory: (accountUrl: string) => BlobStorageClient = createAzureBlobStorageClient,
): Promise<StepResult> {
  if (!config.files || config.files.length === 0) {
    throw new Error('config.files must contain at least one file');
  }

  const results = await Promise.all(
    config.files.map((entry, index) => runOneUpload(entry, index, config, clientFactory, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'upload-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status !== 'Succeeded');
  const outputs: Record<string, string | number | boolean> = {
    totalFiles: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  for (const r of results) {
    outputs[`${r.name}_blobPath`] = r.blobPath;
    outputs[`${r.name}_blobUrl`] = r.blobUrl ?? '';
    outputs[`${r.name}_sizeBytes`] = r.sizeBytes;
    outputs[`${r.name}_status`] = r.status;
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.blobPath}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} file(s) failed to upload:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<UploadToBlobConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
