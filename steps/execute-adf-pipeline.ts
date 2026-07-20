/**
 * Step: execute-adf-pipeline (TypeScript)
 *
 * Triggers one or more Azure Data Factory pipeline runs in parallel and
 * returns immediately with each run's runId — no polling. Split out of
 * the former trigger-adf-pipeline.ts; poll-adf-pipeline-runs.ts now owns
 * polling to completion. An entry with existingRunId set skips triggering
 * entirely and passes that runId through, so this step can sit downstream
 * of wait-for-adf-pipeline-trigger without a YAML condition: to skip it.
 *
 * Auth is a bearer token fetched by an AzureCLI@2 task upstream in the
 * pipeline YAML and mapped into this step's env
 * (config.accessToken -> "{{env.ADF_ACCESS_TOKEN}}").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import { resolveTarget, triggerRun, type AdfDeps, defaultDeps } from './lib/adf-client';

// ---------- Config types --------------------------------------------------

export interface AdfPipelineExecution {
  /** Friendly key used for this entry's output fields; defaults to "p{index}". */
  name?: string;
  pipelineName: string;
  parameters?: Record<string, unknown>;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** If set (non-empty), skip triggering and pass this runId through as-is. */
  existingRunId?: string;
}

export interface ExecuteAdfPipelineConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  pipelines: AdfPipelineExecution[];
}

export interface ExecutionResult {
  name: string;
  pipelineName: string;
  runId?: string;
  status: 'Triggered' | 'PassedThrough' | 'FailedToTrigger';
  message?: string;
}

// ---------- Orchestration ---------------------------------------------------

function outputKeyPrefix(entry: AdfPipelineExecution, index: number): string {
  return entry.name ?? `p${index}`;
}

async function runOnePipeline(
  entry: AdfPipelineExecution,
  index: number,
  config: ExecuteAdfPipelineConfig,
  deps: AdfDeps,
  ctx: StepContext,
): Promise<ExecutionResult> {
  const name = outputKeyPrefix(entry, index);

  if (entry.existingRunId) {
    ctx.log(`"${entry.pipelineName}" (${name}) already triggered automatically -> runId=${entry.existingRunId}, passing through`);
    return {
      name,
      pipelineName: entry.pipelineName,
      runId: entry.existingRunId,
      status: 'PassedThrough',
    };
  }

  try {
    const target = resolveTarget(entry, config, entry.pipelineName);
    const runId = await triggerRun(target, entry.pipelineName, entry.parameters, config.accessToken, deps.fetchImpl);
    ctx.log(`Triggered "${entry.pipelineName}" (${name}) -> runId=${runId}`);
    return { name, pipelineName: entry.pipelineName, runId, status: 'Triggered' };
  } catch (err) {
    return {
      name,
      pipelineName: entry.pipelineName,
      status: 'FailedToTrigger',
      message: (err as Error).message,
    };
  }
}

export async function runAll(
  config: ExecuteAdfPipelineConfig,
  ctx: StepContext,
  deps: AdfDeps = defaultDeps,
): Promise<StepResult> {
  if (!config.accessToken) throw new Error('config.accessToken is required');
  if (!config.pipelines || config.pipelines.length === 0) {
    throw new Error('config.pipelines must contain at least one pipeline run');
  }
  config.pipelines.forEach((entry, i) => {
    if (!entry.pipelineName) throw new Error(`config.pipelines[${i}] is missing pipelineName`);
  });

  const results = await Promise.all(
    config.pipelines.map((entry, index) => runOnePipeline(entry, index, config, deps, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'execution-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status === 'FailedToTrigger');
  const outputs: Record<string, string | number | boolean> = {
    totalPipelines: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  for (const r of results) {
    outputs[`${r.name}_runId`] = r.runId ?? '';
    outputs[`${r.name}_status`] = r.status;
    outputs[`${r.name}_pipelineName`] = r.pipelineName;
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.pipelineName}): ${r.message ?? 'unknown error'}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} ADF pipeline(s) failed to trigger:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<ExecuteAdfPipelineConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
