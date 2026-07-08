#!/usr/bin/env node
/**
 * Generic step runner for Azure Pipelines (TypeScript).
 *
 * Usage (via tsx, no build step needed):
 *   npx tsx runner/run-step.ts --step steps/generate-synthetic-csv.ts \
 *                              --config configs/generate-users-csv.json \
 *                              --name genUsersCsv
 *
 * See runner/types.ts for the step contract.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StepContext, StepModule, StepOutputFile } from './types';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function workspaceRoot(): string {
  return process.env.PIPELINE_WORKSPACE || process.env.AGENT_TEMPDIRECTORY || process.cwd();
}

function stepOutputDir(stepName: string): string {
  return path.join(workspaceRoot(), 'step-output', stepName);
}

/** Load all previously-written step outputs so configs can reference them. */
function loadPriorOutputs(): Record<string, StepOutputFile> {
  const root = path.join(workspaceRoot(), 'step-output');
  const steps: Record<string, StepOutputFile> = {};
  if (!fs.existsSync(root)) return steps;
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, 'output.json');
    if (fs.existsSync(file)) {
      try {
        steps[dir] = JSON.parse(fs.readFileSync(file, 'utf8')) as StepOutputFile;
      } catch {
        /* ignore malformed outputs */
      }
    }
  }
  return steps;
}

/** Replace {{steps.name.outputs.key}} / {{env.VAR}} tokens anywhere in the config. */
function interpolate(value: Json, context: Record<string, unknown>): Json {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, expr: string) => {
      let cur: unknown = context;
      for (const part of expr.split('.')) {
        if (cur == null || typeof cur !== 'object') return '';
        cur = (cur as Record<string, unknown>)[part];
      }
      return cur == null ? '' : String(cur);
    });
  }
  if (Array.isArray(value)) return value.map(v => interpolate(v, context));
  if (value && typeof value === 'object') {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, context);
    return out;
  }
  return value;
}

function resolveConfig(
  args: Record<string, string>,
  priorSteps: Record<string, StepOutputFile>,
): Record<string, Json> {
  let config: Record<string, Json> = {};
  if (args.config) {
    config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  }
  if (args['config-json']) {
    config = { ...config, ...JSON.parse(args['config-json']) };
  }
  // Env overrides: STEP_CONFIG_rowCount=500 -> config.rowCount = "500"
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('STEP_CONFIG_') && v !== undefined) {
      config[k.slice('STEP_CONFIG_'.length)] = v;
    }
  }
  return interpolate(config, { steps: priorSteps, env: process.env }) as Record<string, Json>;
}

/** Emit an Azure DevOps logging command to set a pipeline variable. */
function setPipelineVariable(name: string, value: unknown, isOutput = true): void {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`##vso[task.setvariable variable=${name};isOutput=${isOutput}]${v}`);
}

async function loadStepModule(stepPath: string): Promise<StepModule> {
  const mod = await import(pathToFileURL(stepPath).href);
  const step: unknown = mod.default ?? mod;
  if (!step || typeof (step as StepModule).run !== 'function') {
    throw new Error(`Step module ${stepPath} does not export a run(config, ctx) function`);
  }
  return step as StepModule;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.step) {
    console.error('Missing --step <path-to-step-module>');
    process.exit(1);
  }

  const stepPath = path.resolve(args.step);
  const stepName = args.name || path.basename(stepPath).replace(/\.(ts|js)$/, '');
  const priorSteps = loadPriorOutputs();
  const config = resolveConfig(args, priorSteps);

  const outDir = stepOutputDir(stepName);
  fs.mkdirSync(outDir, { recursive: true });

  const ctx: StepContext = {
    stepName,
    outDir,
    workspace: workspaceRoot(),
    steps: priorSteps,
    log: (...m) => console.log(`[${stepName}]`, ...m),
    warn: (...m) => console.log(`##vso[task.logissue type=warning][${stepName}] ${m.join(' ')}`),
  };

  ctx.log(`Running step module: ${stepPath}`);
  ctx.log(`Resolved config: ${JSON.stringify(config, null, 2)}`);

  const stepModule = await loadStepModule(stepPath);

  const started = Date.now();
  let result;
  try {
    result = (await stepModule.run(config, ctx)) || {};
  } catch (err) {
    const e = err as Error;
    const failure: StepOutputFile = {
      step: stepName,
      ok: false,
      error: { message: e.message, stack: e.stack },
      durationMs: Date.now() - started,
      outputs: {},
      artifacts: [],
    };
    fs.writeFileSync(path.join(outDir, 'output.json'), JSON.stringify(failure, null, 2));
    console.log(`##vso[task.logissue type=error][${stepName}] ${e.message}`);
    console.log('##vso[task.complete result=Failed]');
    process.exit(1);
  }

  const output: StepOutputFile = {
    step: stepName,
    ok: true,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    config,
    outputs: result.outputs ?? {},
    artifacts: result.artifacts ?? [],
  };

  fs.writeFileSync(path.join(outDir, 'output.json'), JSON.stringify(output, null, 2));

  for (const [k, v] of Object.entries(output.outputs)) {
    setPipelineVariable(`${stepName}.${k}`, v);
  }
  setPipelineVariable(`${stepName}.outputJsonPath`, path.join(outDir, 'output.json'));

  ctx.log(`Done in ${output.durationMs}ms. Outputs: ${JSON.stringify(output.outputs)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
