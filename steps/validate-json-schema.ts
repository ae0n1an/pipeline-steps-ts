/**
 * Step: validate-json-schema (TypeScript)
 *
 * Validates one or more JSON files against a caller-supplied JSON Schema
 * (draft-07, via ajv's default export). Files are processed sequentially;
 * the step fails fast on the first entry that doesn't validate, with
 * every ajv validation error included in the failure message.
 */

import * as fs from 'node:fs';
import Ajv from 'ajv';
import { defineStep, type StepContext, type StepResult } from '../runner/types';

export interface SchemaEntry {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  filePath: string;
  schemaPath: string;
}

export interface ValidateJsonSchemaConfig {
  files: SchemaEntry[];
}

function validateOneFile(entry: SchemaEntry): void {
  if (!entry.filePath) throw new Error('filePath is required');
  if (!entry.schemaPath) throw new Error('schemaPath is required');
  if (!fs.existsSync(entry.filePath)) throw new Error(`File not found: ${entry.filePath}`);
  if (!fs.existsSync(entry.schemaPath)) throw new Error(`Schema not found: ${entry.schemaPath}`);

  const schema = JSON.parse(fs.readFileSync(entry.schemaPath, 'utf8'));
  const data = JSON.parse(fs.readFileSync(entry.filePath, 'utf8'));

  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    const detail = (validate.errors ?? [])
      .map(e => `  - ${e.instancePath || '(root)'}: ${e.message}`)
      .join('\n');
    throw new Error(`Schema validation failed:\n${detail}`);
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
