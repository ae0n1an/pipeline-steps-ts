/**
 * Core logic for scenario regression testing: run a scenario's steps
 * through the real runner CLI, normalize each step's output.json into a
 * deterministic, portable shape, and compare against (or write) a golden
 * file. See test/scenarios.test.ts for the thin glue that discovers
 * fixtures and drives this per-scenario.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { StepOutputFile } from '../../runner/types';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------- Scenario execution -----------------------------------------------

export interface ScenarioStep {
  /** Path to the step module, relative to repo root, e.g. "steps/generate-synthetic-csv.ts". */
  step: string;
  /** The step's config — same shape as any configs/*.json file. */
  config: unknown;
  /** Output key prefix; matches the runner's --name. */
  name: string;
}

export interface Scenario {
  description?: string;
  steps: ScenarioStep[];
}

export function runScenario(scenario: Scenario, workspaceDir: string): Record<string, unknown> {
  const results: Record<string, unknown> = {};

  for (const step of scenario.steps) {
    const configPath = path.join(workspaceDir, `${step.name}.config.json`);
    fs.writeFileSync(configPath, JSON.stringify(step.config));

    const result = spawnSync(
      'npx',
      ['tsx', 'runner/run-step.ts', '--step', step.step, '--config', configPath, '--name', step.name],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PIPELINE_WORKSPACE: workspaceDir },
        encoding: 'utf8',
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Scenario step "${step.name}" (${step.step}) exited with code ${result.status}:\n${result.stdout}\n${result.stderr}`,
      );
    }

    const outputPath = path.join(workspaceDir, 'step-output', step.name, 'output.json');
    results[step.name] = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  }

  return results;
}

// ---------- Normalization ---------------------------------------------------

export interface NormalizedStepResult {
  ok: boolean;
  outputs: Record<string, string | number | boolean>;
  artifacts: string[];
  fileHashes: Record<string, string>;
  error?: { message: string };
}

export type NormalizedScenarioResult = Record<string, NormalizedStepResult>;

export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function normalizePath(value: string, workspaceRoot: string): string {
  return path.isAbsolute(value) ? path.relative(workspaceRoot, value) : value;
}

export function normalizeStepOutput(raw: StepOutputFile, workspaceRoot: string): NormalizedStepResult {
  const outputs: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw.outputs ?? {})) {
    outputs[key] = typeof value === 'string' ? normalizePath(value, workspaceRoot) : value;
  }

  const artifacts = [...(raw.artifacts ?? [])].map(p => normalizePath(p, workspaceRoot)).sort();

  const fileHashes: Record<string, string> = {};
  for (const artifactPath of raw.artifacts ?? []) {
    fileHashes[normalizePath(artifactPath, workspaceRoot)] = hashFile(artifactPath);
  }

  const result: NormalizedStepResult = { ok: raw.ok, outputs, artifacts, fileHashes };
  if (raw.error) result.error = { message: raw.error.message };
  return result;
}

// ---------- Comparison -------------------------------------------------------

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as object).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function diffNormalized(actual: NormalizedScenarioResult, golden: NormalizedScenarioResult): string[] {
  const diffs: string[] = [];
  const allKeys = new Set([...Object.keys(actual), ...Object.keys(golden)]);
  for (const key of allKeys) {
    const a = actual[key];
    const g = golden[key];
    if (!g) {
      diffs.push(`step "${key}": present in actual but missing from golden`);
      continue;
    }
    if (!a) {
      diffs.push(`step "${key}": present in golden but missing from actual`);
      continue;
    }
    if (stableStringify(a) !== stableStringify(g)) {
      diffs.push(`step "${key}": mismatch\n  actual: ${JSON.stringify(a)}\n  golden: ${JSON.stringify(g)}`);
    }
  }
  return diffs;
}

// ---------- Golden file I/O --------------------------------------------------

export function readGolden(goldenPath: string): NormalizedScenarioResult | undefined {
  if (!fs.existsSync(goldenPath)) return undefined;
  return JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
}

export function writeGolden(goldenPath: string, result: NormalizedScenarioResult): void {
  fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
  fs.writeFileSync(goldenPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
}
