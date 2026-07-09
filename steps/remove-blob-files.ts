/**
 * Step: remove-blob-files (TypeScript)
 *
 * Deletes blobs matching one or more glob path patterns, e.g.
 * `inbound/2026-[*]/[*].gpg`. Pattern-based cleanup only — no age filtering.
 * Patterns are processed concurrently; the step waits for all patterns
 * before deciding pass/fail and throws one aggregated error if any
 * pattern's processing failed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import {
  createAzureBlobStorageClient,
  resolveBlobTarget,
  type BlobStorageClient,
} from './lib/blob-client';

export interface PatternEntry {
  /** Output key prefix for this pattern's results; defaults to "f{index}". */
  name?: string;
  pattern: string;
  accountUrl?: string;
  containerName?: string;
}

export interface RemoveBlobFilesConfig {
  accountUrl?: string;
  containerName?: string;
  patterns: PatternEntry[];
}

export interface PatternResult {
  name: string;
  pattern: string;
  matchedCount: number;
  deletedCount: number;
  deletedPaths: string[];
  status: 'Succeeded' | 'Failed';
  message?: string;
}

// ---------- Glob matching ---------------------------------------------------

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function literalPrefix(pattern: string): string {
  const idx = pattern.indexOf('*');
  return idx === -1 ? pattern : pattern.slice(0, idx);
}

// ---------- Per-pattern processing ------------------------------------------

async function runOnePattern(
  entry: PatternEntry,
  index: number,
  config: RemoveBlobFilesConfig,
  clientFactory: (accountUrl: string) => BlobStorageClient,
  ctx: StepContext,
): Promise<PatternResult> {
  const name = entry.name ?? `f${index}`;
  try {
    const target = resolveBlobTarget(entry, config);
    const client = clientFactory(target.accountUrl);
    const regex = globToRegExp(entry.pattern);
    const prefix = literalPrefix(entry.pattern);

    const matches: string[] = [];
    for await (const blob of client.listBlobs(target.containerName, prefix)) {
      if (regex.test(blob.name)) matches.push(blob.name);
    }

    ctx.log(`Pattern "${entry.pattern}" (${name}) matched ${matches.length} blob(s)`);

    await Promise.all(matches.map(blobPath => client.deleteBlob(target.containerName, blobPath)));

    return {
      name,
      pattern: entry.pattern,
      matchedCount: matches.length,
      deletedCount: matches.length,
      deletedPaths: matches,
      status: 'Succeeded',
    };
  } catch (err) {
    return {
      name,
      pattern: entry.pattern,
      matchedCount: 0,
      deletedCount: 0,
      deletedPaths: [],
      status: 'Failed',
      message: (err as Error).message,
    };
  }
}

// ---------- Orchestration ----------------------------------------------------

export async function runAll(
  config: RemoveBlobFilesConfig,
  ctx: StepContext,
  clientFactory: (accountUrl: string) => BlobStorageClient = createAzureBlobStorageClient,
): Promise<StepResult> {
  if (!config.patterns || config.patterns.length === 0) {
    throw new Error('config.patterns must contain at least one pattern');
  }

  const results = await Promise.all(
    config.patterns.map((entry, index) => runOnePattern(entry, index, config, clientFactory, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'delete-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status !== 'Succeeded');
  const outputs: Record<string, string | number | boolean> = {
    totalPatterns: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  for (const r of results) {
    outputs[`${r.name}_matchedCount`] = r.matchedCount;
    outputs[`${r.name}_deletedCount`] = r.deletedCount;
    outputs[`${r.name}_status`] = r.status;
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.pattern}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} pattern(s) failed to process:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<RemoveBlobFilesConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
