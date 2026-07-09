/**
 * Step: validate-business-logic (TypeScript)
 *
 * Checks declarative cross-file rules between a CSV and a JSON file (e.g.
 * an inbound payload CSV against an outbound JSON result), correlating
 * rows/entries by a key field on each side. Files are processed
 * sequentially; for each entry every configured rule is checked (not just
 * the first violation), and the step fails fast on the first entry with
 * any violation.
 */

import * as fs from 'node:fs';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import { parseCsv } from './lib/csv';

export type Rule =
  | { type: 'rowCountMatches'; tolerance?: number }
  | { type: 'allCsvRowsHaveJsonMatch' }
  | { type: 'allJsonEntriesHaveCsvMatch' }
  | { type: 'fieldsEqual'; csvField: string; jsonField: string };

export interface BusinessLogicEntry {
  /** Output key prefix for this entry's results; defaults to "f{index}". */
  name?: string;
  csvPath: string;
  jsonPath: string;
  csvKeyField: string;
  jsonKeyField: string;
  rules: Rule[];
}

export interface ValidateBusinessLogicConfig {
  files: BusinessLogicEntry[];
}

function checkRule(
  rule: Rule,
  csvRows: Record<string, string>[],
  jsonEntries: Record<string, unknown>[],
  csvByKey: Map<string, Record<string, string>>,
  jsonByKey: Map<string, Record<string, unknown>>,
): string[] {
  const violations: string[] = [];

  switch (rule.type) {
    case 'rowCountMatches': {
      const diff = Math.abs(csvRows.length - jsonEntries.length);
      if (diff > (rule.tolerance ?? 0)) {
        violations.push(
          `rowCountMatches: csv has ${csvRows.length} row(s), json has ${jsonEntries.length} entr(y/ies), diff ${diff} exceeds tolerance ${rule.tolerance ?? 0}`,
        );
      }
      break;
    }
    case 'allCsvRowsHaveJsonMatch': {
      for (const key of csvByKey.keys()) {
        if (!jsonByKey.has(key)) violations.push(`allCsvRowsHaveJsonMatch: csv key "${key}" has no json match`);
      }
      break;
    }
    case 'allJsonEntriesHaveCsvMatch': {
      for (const key of jsonByKey.keys()) {
        if (!csvByKey.has(key)) violations.push(`allJsonEntriesHaveCsvMatch: json key "${key}" has no csv match`);
      }
      break;
    }
    case 'fieldsEqual': {
      for (const [key, csvRow] of csvByKey) {
        const jsonEntry = jsonByKey.get(key);
        if (!jsonEntry) continue; // reported by allCsvRowsHaveJsonMatch if that rule is also configured
        const csvValue = csvRow[rule.csvField];
        const jsonValue = jsonEntry[rule.jsonField];
        if (String(csvValue) !== String(jsonValue)) {
          violations.push(
            `fieldsEqual: key "${key}" csv.${rule.csvField}="${csvValue}" !== json.${rule.jsonField}="${jsonValue}"`,
          );
        }
      }
      break;
    }
    default: {
      const never: never = rule;
      throw new Error(`Unknown rule type: ${JSON.stringify(never)}`);
    }
  }

  return violations;
}

function checkOneEntry(entry: BusinessLogicEntry): void {
  if (!entry.csvPath) throw new Error('csvPath is required');
  if (!entry.jsonPath) throw new Error('jsonPath is required');
  if (!fs.existsSync(entry.csvPath)) throw new Error(`CSV file not found: ${entry.csvPath}`);
  if (!fs.existsSync(entry.jsonPath)) throw new Error(`JSON file not found: ${entry.jsonPath}`);
  if (!entry.rules || entry.rules.length === 0) throw new Error('rules must contain at least one rule');

  const { rows: csvRows } = parseCsv(fs.readFileSync(entry.csvPath, 'utf8'));
  const jsonEntries = JSON.parse(fs.readFileSync(entry.jsonPath, 'utf8'));
  if (!Array.isArray(jsonEntries)) {
    throw new Error(`JSON file's top-level value is not an array: ${entry.jsonPath}`);
  }

  const csvByKey = new Map(csvRows.map(r => [String(r[entry.csvKeyField]), r]));
  const jsonByKey = new Map(
    (jsonEntries as Record<string, unknown>[]).map(e => [String(e[entry.jsonKeyField]), e]),
  );

  const violations = entry.rules.flatMap(rule => checkRule(rule, csvRows, jsonEntries, csvByKey, jsonByKey));

  if (violations.length > 0) {
    throw new Error(`${violations.length} rule violation(s):\n${violations.map(v => `  - ${v}`).join('\n')}`);
  }
}

export function runAll(config: ValidateBusinessLogicConfig, ctx: StepContext): StepResult {
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
      checkOneEntry(entry);
    } catch (err) {
      throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
    }
    ctx.log(`"${entry.csvPath}" vs "${entry.jsonPath}" (${name}): all ${entry.rules.length} rule(s) passed`);
    outputs[`${name}_status`] = 'Succeeded';
    outputs[`${name}_rulesChecked`] = entry.rules.length;
  }

  return { outputs };
}

export default defineStep<ValidateBusinessLogicConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
