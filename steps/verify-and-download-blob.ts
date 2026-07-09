/**
 * Step: verify-and-download-blob (TypeScript)
 *
 * Verifies that one or more expected blobs exist and downloads each one
 * that does. An entry whose blob is missing fails the step by default
 * (required: true); set required: false to record a miss without failing.
 * Files are processed concurrently; the step waits for all files before
 * deciding pass/fail and throws one aggregated error if any required file
 * was missing or failed to download.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import {
  createAzureBlobStorageClient,
  resolveBlobTarget,
  type BlobStorageClient,
} from './lib/blob-client';

export interface VerifyEntry {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  blobPath: string;
  /** Defaults to ctx.outDir/<basename of blobPath>. */
  localPath?: string;
  /** Fail the step if this blob is missing; default true. */
  required?: boolean;
  accountUrl?: string;
  containerName?: string;
}

export interface VerifyAndDownloadConfig {
  accountUrl?: string;
  containerName?: string;
  files: VerifyEntry[];
}

export interface VerifyResult {
  name: string;
  blobPath: string;
  exists: boolean;
  localPath?: string;
  sizeBytes: number;
  status: 'Succeeded' | 'Failed';
  message?: string;
}

async function runOneVerify(
  entry: VerifyEntry,
  index: number,
  config: VerifyAndDownloadConfig,
  clientFactory: (accountUrl: string) => BlobStorageClient,
  ctx: StepContext,
): Promise<VerifyResult> {
  const name = entry.name ?? `f${index}`;
  const required = entry.required ?? true;
  try {
    if (!entry.blobPath) throw new Error('blobPath is required');
    const target = resolveBlobTarget(entry, config);
    const client = clientFactory(target.accountUrl);

    const exists = await client.blobExists(target.containerName, entry.blobPath);
    if (!exists) {
      if (required) throw new Error(`Blob not found: ${entry.blobPath}`);
      return { name, blobPath: entry.blobPath, exists: false, sizeBytes: 0, status: 'Succeeded' };
    }

    const localPath = entry.localPath ?? path.join(ctx.outDir, path.basename(entry.blobPath));
    const { sizeBytes } = await client.downloadBlob(target.containerName, entry.blobPath, localPath);
    ctx.log(`Downloaded "${entry.blobPath}" (${name}) -> ${localPath}`);

    return { name, blobPath: entry.blobPath, exists: true, localPath, sizeBytes, status: 'Succeeded' };
  } catch (err) {
    return {
      name,
      blobPath: entry.blobPath,
      exists: false,
      sizeBytes: 0,
      status: 'Failed',
      message: (err as Error).message,
    };
  }
}

export async function runAll(
  config: VerifyAndDownloadConfig,
  ctx: StepContext,
  clientFactory: (accountUrl: string) => BlobStorageClient = createAzureBlobStorageClient,
): Promise<StepResult> {
  if (!config.files || config.files.length === 0) {
    throw new Error('config.files must contain at least one file');
  }

  const results = await Promise.all(
    config.files.map((entry, index) => runOneVerify(entry, index, config, clientFactory, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'verify-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status !== 'Succeeded');
  const outputs: Record<string, string | number | boolean> = {
    totalFiles: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  const artifacts: string[] = [];
  for (const r of results) {
    outputs[`${r.name}_exists`] = r.exists;
    outputs[`${r.name}_localPath`] = r.localPath ?? '';
    outputs[`${r.name}_sizeBytes`] = r.sizeBytes;
    outputs[`${r.name}_status`] = r.status;
    if (r.localPath) artifacts.push(r.localPath);
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.blobPath}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} file(s) failed verification:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath, ...artifacts] };
}

export default defineStep<VerifyAndDownloadConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
