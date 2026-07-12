/**
 * Step: generate-synthetic-csv (TypeScript)
 *
 * Generates one or more mock CSV payloads from declarative column configs.
 * Column types are a discriminated union, so tsc catches invalid column
 * configs (e.g. "values" on an int column) at compile time when configs are
 * authored in TS; JSON configs are validated at runtime.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext } from '../runner/types';

// ---------- Config types -------------------------------------------------

interface BaseColumn {
  name: string;
  /** Header row text for this column; defaults to name. */
  header?: string;
  /** 0..1 chance of emitting an empty cell, for sparse data. */
  nullProbability?: number;
}

export type ColumnConfig =
  | (BaseColumn & { type: 'uuid' })
  | (BaseColumn & { type: 'firstName' | 'lastName' | 'fullName' | 'email' })
  | (BaseColumn & { type: 'int'; min?: number; max?: number })
  | (BaseColumn & { type: 'float'; min?: number; max?: number; decimals?: number })
  | (BaseColumn & { type: 'bool'; trueProbability?: number })
  | (BaseColumn & { type: 'date'; from?: string; to?: string; format?: 'iso' | 'date' })
  | (BaseColumn & { type: 'enum'; values: string[] })
  | (BaseColumn & { type: 'template'; template: string })
  | (BaseColumn & { type: 'constant'; value: string | number | boolean });

export interface FileConfig {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  fileName?: string;
  rowCount?: number | string; // string when overridden via STEP_CONFIG_ env
  seed?: number | string;
  columns: ColumnConfig[];
}

export interface GenerateCsvConfig {
  files: FileConfig[];
}

// ---------- Deterministic RNG (mulberry32) -------------------------------

type Rng = () => number;

function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = ['Alice', 'Bob', 'Carla', 'Dev', 'Elena', 'Farid', 'Grace', 'Hiro', 'Ines', 'Jack', 'Kim', 'Luca', 'Mei', 'Noah', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Umar'];
const LAST_NAMES = ['Nguyen', 'Smith', 'Garcia', 'Kaur', 'Chen', 'Okafor', 'Rossi', 'Tanaka', 'Brown', 'Silva', 'Kowalski', 'Ali', 'Martin', 'Ivanov', 'Lee', 'Papadopoulos'];
const DOMAINS = ['example.com', 'test.io', 'mock.dev', 'sample.org'];

const pick = <T,>(rng: Rng, arr: T[]): T => arr[Math.floor(rng() * arr.length)];

function generateValue(rng: Rng, col: ColumnConfig, rowIndex: number): string | number | boolean {
  switch (col.type) {
    case 'uuid':
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.floor(rng() * 16);
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    case 'firstName': return pick(rng, FIRST_NAMES);
    case 'lastName': return pick(rng, LAST_NAMES);
    case 'fullName': return `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    case 'email':
      return `${pick(rng, FIRST_NAMES).toLowerCase()}.${pick(rng, LAST_NAMES).toLowerCase()}${Math.floor(rng() * 1000)}@${pick(rng, DOMAINS)}`;
    case 'int': {
      const min = col.min ?? 0;
      const max = col.max ?? 100;
      return Math.floor(rng() * (max - min + 1)) + min;
    }
    case 'float': {
      const min = col.min ?? 0;
      const max = col.max ?? 1;
      return (rng() * (max - min) + min).toFixed(col.decimals ?? 2);
    }
    case 'bool': return rng() < (col.trueProbability ?? 0.5);
    case 'date': {
      const from = new Date(col.from ?? '2000-01-01').getTime();
      const to = new Date(col.to ?? Date.now()).getTime();
      const d = new Date(from + rng() * (to - from));
      return col.format === 'date' ? d.toISOString().slice(0, 10) : d.toISOString();
    }
    case 'enum': return pick(rng, col.values);
    case 'template': return col.template.replace('{rowIndex}', String(rowIndex));
    case 'constant': return col.value;
    default: {
      const never: never = col;
      throw new Error(`Unknown column type: ${JSON.stringify(never)}`);
    }
  }
}

function csvEscape(value: string | number | boolean | null): string {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- Per-file generation --------------------------------------------

interface OneFileResult {
  fileName: string;
  filePath: string;
  rowCount: number;
  seed: number;
  columnNames: string;
  sizeBytes: number;
}

function generateOneFile(file: FileConfig, index: number, ctx: StepContext): OneFileResult {
  const rowCount = Number(file.rowCount ?? 100);
  const columns = file.columns ?? [];
  if (!columns.length) throw new Error('columns must define at least one column');

  const seed = Number(file.seed ?? Date.now());
  const rng = makeRng(seed);
  const fileName = file.fileName ?? `synthetic-${index}.csv`;
  const filePath = path.join(ctx.outDir, fileName);

  ctx.log(`Generating ${rowCount} rows, ${columns.length} columns, seed=${seed} -> ${fileName}`);

  const lines: string[] = [columns.map(c => csvEscape(c.header ?? c.name)).join(',')];
  for (let i = 0; i < rowCount; i++) {
    const row = columns.map(col => {
      if (col.nullProbability && rng() < col.nullProbability) return '';
      return csvEscape(generateValue(rng, col, i));
    });
    lines.push(row.join(','));
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  const stats = fs.statSync(filePath);

  return {
    fileName,
    filePath,
    rowCount,
    seed,
    columnNames: columns.map(c => c.header ?? c.name).join(','),
    sizeBytes: stats.size,
  };
}

// ---------- Step ------------------------------------------------------------

export default defineStep<GenerateCsvConfig>({
  async run(config, ctx) {
    if (!config.files || config.files.length === 0) {
      throw new Error('config.files must contain at least one file');
    }

    const outputs: Record<string, string | number | boolean> = {
      totalFiles: config.files.length,
    };
    const artifacts: string[] = [];

    for (let index = 0; index < config.files.length; index++) {
      const file = config.files[index];
      const name = file.name ?? `f${index}`;
      let result: OneFileResult;
      try {
        result = generateOneFile(file, index, ctx);
      } catch (err) {
        throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
      }
      outputs[`${name}_csvPath`] = result.filePath;
      outputs[`${name}_fileName`] = result.fileName;
      outputs[`${name}_rowCount`] = result.rowCount;
      outputs[`${name}_columnNames`] = result.columnNames;
      outputs[`${name}_seed`] = result.seed;
      outputs[`${name}_sizeBytes`] = result.sizeBytes;
      artifacts.push(result.filePath);
    }

    return { outputs, artifacts };
  },
});
