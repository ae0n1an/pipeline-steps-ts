/**
 * Step: verify-row-count (TypeScript)
 *
 * Verifies one or more files' row/entry counts fall within a min/max
 * range. CSV files are parsed with the shared parser (excludes the
 * header row); JSON files must have a top-level array, counted by
 * length. Files are processed sequentially; the step fails fast on the
 * first entry outside its configured range.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import { parseCsv } from './lib/csv';

export interface RowCountEntry {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  filePath: string;
  /** Defaults from the file extension (.csv -> csv, .json -> json). */
  format?: 'csv' | 'json';
  minRows?: number;
  maxRows?: number;
}

export interface VerifyRowCountConfig {
  files: RowCountEntry[];
}

function inferFormat(filePath: string): 'csv' | 'json' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.json') return 'json';
  throw new Error(`Cannot infer format from extension "${ext}"; set format explicitly`);
}

function countRows(filePath: string, format: 'csv' | 'json'): number {
  const content = fs.readFileSync(filePath, 'utf8');
  if (format === 'csv') {
    return parseCsv(content).rows.length;
  }
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error(`JSON file's top-level value is not an array: ${filePath}`);
  }
  return parsed.length;
}

function checkOneFile(entry: RowCountEntry): { rowCount: number } {
  if (!entry.filePath) throw new Error('filePath is required');
  if (!fs.existsSync(entry.filePath)) throw new Error(`File not found: ${entry.filePath}`);

  const format = entry.format ?? inferFormat(entry.filePath);
  const rowCount = countRows(entry.filePath, format);

  if (entry.minRows !== undefined && rowCount < entry.minRows) {
    throw new Error(`rowCount ${rowCount} is below minRows ${entry.minRows}`);
  }
  if (entry.maxRows !== undefined && rowCount > entry.maxRows) {
    throw new Error(`rowCount ${rowCount} is above maxRows ${entry.maxRows}`);
  }

  return { rowCount };
}

export function runAll(config: VerifyRowCountConfig, ctx: StepContext): StepResult {
  if (!config.files || config.files.length === 0) {
    throw new Error('config.files must contain at least one file');
  }

  const outputs: Record<string, string | number | boolean> = {
    totalFiles: config.files.length,
  };

  for (let index = 0; index < config.files.length; index++) {
    const entry = config.files[index];
    const name = entry.name ?? `f${index}`;
    let result: { rowCount: number };
    try {
      result = checkOneFile(entry);
    } catch (err) {
      throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
    }
    ctx.log(`"${entry.filePath}" (${name}) has ${result.rowCount} row(s)`);
    outputs[`${name}_rowCount`] = result.rowCount;
    outputs[`${name}_status`] = 'Succeeded';
  }

  return { outputs };
}

export default defineStep<VerifyRowCountConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
