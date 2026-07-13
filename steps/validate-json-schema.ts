/**
 * Step: validate-json-schema (TypeScript)
 *
 * Validates one or more JSON files against a caller-supplied JSON Schema
 * (draft-07, via ajv's default export). Files are processed sequentially;
 * the step fails fast on the first entry that doesn't validate, with
 * every ajv validation error included in the failure message.
 *
 * "ndjson" format (newline-delimited JSON, aka LDJSON/JSONL) validates
 * each line of the file as its own independent JSON value against the
 * same schema, rather than parsing the whole file as one JSON document.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv from 'ajv';
import { defineStep, type StepContext, type StepResult } from '../runner/types';

export interface SchemaEntry {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  filePath: string;
  schemaPath: string;
  /** Defaults from the file extension (.json -> json, .ndjson/.jsonl/.ldjson -> ndjson). */
  format?: 'json' | 'ndjson';
}

export interface ValidateJsonSchemaConfig {
  files: SchemaEntry[];
}

function inferFormat(filePath: string): 'json' | 'ndjson' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.ndjson' || ext === '.jsonl' || ext === '.ldjson') return 'ndjson';
  throw new Error(`Cannot infer format from extension "${ext}"; set format explicitly`);
}

function formatAjvErrors(errors: Ajv['errors']): string {
  return (errors ?? [])
    .map(e => `  - ${e.instancePath || '(root)'}: ${e.message}`)
    .join('\n');
}

function validateWholeDocument(filePath: string, validate: ReturnType<Ajv['compile']>): void {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!validate(data)) {
    throw new Error(`Schema validation failed:\n${formatAjvErrors(validate.errors)}`);
  }
}

function validateNdjson(filePath: string, validate: ReturnType<Ajv['compile']>): void {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const failures: string[] = [];

  lines.forEach((line, i) => {
    const lineNumber = i + 1;
    const trimmed = line.trim();
    if (trimmed === '') return;

    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch (err) {
      failures.push(`line ${lineNumber}: invalid JSON (${(err as Error).message})`);
      return;
    }
    if (!validate(data)) {
      failures.push(`line ${lineNumber}:\n${formatAjvErrors(validate.errors)}`);
    }
  });

  if (failures.length > 0) {
    throw new Error(`Schema validation failed for ${failures.length} line(s):\n${failures.join('\n')}`);
  }
}

function validateOneFile(entry: SchemaEntry): void {
  if (!entry.filePath) throw new Error('filePath is required');
  if (!entry.schemaPath) throw new Error('schemaPath is required');
  if (!fs.existsSync(entry.filePath)) throw new Error(`File not found: ${entry.filePath}`);
  if (!fs.existsSync(entry.schemaPath)) throw new Error(`Schema not found: ${entry.schemaPath}`);

  const schema = JSON.parse(fs.readFileSync(entry.schemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  const format = entry.format ?? inferFormat(entry.filePath);
  if (format === 'ndjson') {
    validateNdjson(entry.filePath, validate);
  } else {
    validateWholeDocument(entry.filePath, validate);
  }
}

export function runAll(config: ValidateJsonSchemaConfig, ctx: StepContext): StepResult {
  if (!config.files || config.files.length === 0) {
    throw new Error('config.files must contain at least one file');
  }

  const outputs: Record<string, string | number | boolean> = {
    totalFiles: config.files.length,
  };

  for (let index = 0; index < config.files.length; index++) {
    const entry = config.files[index];
    const name = entry.name ?? `f${index}`;
    try {
      validateOneFile(entry);
    } catch (err) {
      throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
    }
    ctx.log(`"${entry.filePath}" (${name}) validated against "${entry.schemaPath}"`);
    outputs[`${name}_status`] = 'Succeeded';
  }

  return { outputs };
}

export default defineStep<ValidateJsonSchemaConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
