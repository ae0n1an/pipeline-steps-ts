/**
 * Step: poll-adf-pipeline-runs (TypeScript)
 *
 * Polls a list of already-triggered Azure Data Factory pipeline runs (by
 * runId) to a terminal status, in parallel. Split out of the former
 * trigger-adf-pipeline.ts; execute-adf-pipeline.ts now owns triggering.
 *
 * Auth is a bearer token fetched by an AzureCLI@2 task upstream in the
 * pipeline YAML and mapped into this step's env
 * (config.accessToken -> "{{env.ADF_ACCESS_TOKEN}}").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import { resolveTarget, pollUntilTerminal, type AdfDeps, defaultDeps } from './lib/adf-client';

// ---------- Config types --------------------------------------------------

export interface AdfRunToPoll {
  /** Friendly key used for this entry's output fields; defaults to "p{index}". */
  name?: string;
  runId: string;
  /** Optional, informational only — passed through to this entry's output if supplied, not used in any API call. */
  pipelineName?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export interface PollAdfPipelineRunsConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** Poll interval while waiting for a run to finish. Default 15000. */
  pollIntervalMs?: number | string;
  /** Max time to wait for a single run before treating it as failed. Default 3600000 (1h). */
  timeoutMs?: number | string;
  runs: AdfRunToPoll[];
}

export interface PollResult {
  name: string;
  runId: string;
  pipelineName?: string;
  status: string;
  durationMs: number;
  message?: string;
}

// ---------- Orchestration ---------------------------------------------------

function outputKeyPrefix(entry: AdfRunToPoll, index: number): string {
  return entry.name ?? `p${index}`;
}

async function pollOneRun(
  entry: AdfRunToPoll,
  index: number,
  config: PollAdfPipelineRunsConfig,
  deps: AdfDeps,
  ctx: StepContext,
): Promise<PollResult> {
  const name = outputKeyPrefix(entry, index);
  const startedAt = deps.nowImpl();
  try {
    const target = resolveTarget(entry, config, entry.runId);
    const outcome = await pollUntilTerminal(
      target,
      entry.runId,
      config.accessToken,
      {
        pollIntervalMs: Number(config.pollIntervalMs ?? 15000),
        timeoutMs: Number(config.timeoutMs ?? 3600000),
      },
      deps,
    );
    ctx.log(`Polled run "${entry.runId}" (${name}) -> ${outcome.status}`);
    return {
      name,
      runId: entry.runId,
      pipelineName: entry.pipelineName,
      status: outcome.status,
      durationMs: deps.nowImpl() - startedAt,
      message: outcome.message,
    };
  } catch (err) {
    return {
      name,
      runId: entry.runId,
      pipelineName: entry.pipelineName,
      status: 'Failed',
      durationMs: deps.nowImpl() - startedAt,
      message: (err as Error).message,
    };
  }
}

export async function runAll(
  config: PollAdfPipelineRunsConfig,
  ctx: StepContext,
  deps: AdfDeps = defaultDeps,
): Promise<StepResult> {
  if (!config.accessToken) throw new Error('config.accessToken is required');
  if (!config.runs || config.runs.length === 0) {
    throw new Error('config.runs must contain at least one run');
  }
  config.runs.forEach((entry, i) => {
    if (!entry.runId) throw new Error(`config.runs[${i}] is missing runId`);
  });

  const results = await Promise.all(
    config.runs.map((entry, index) => pollOneRun(entry, index, config, deps, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'poll-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status !== 'Succeeded');
  const outputs: Record<string, string | number | boolean> = {
    totalPipelines: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  for (const r of results) {
    outputs[`${r.name}_runId`] = r.runId;
    outputs[`${r.name}_status`] = r.status;
    if (r.pipelineName !== undefined) outputs[`${r.name}_pipelineName`] = r.pipelineName;
    outputs[`${r.name}_durationMs`] = r.durationMs;
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (runId=${r.runId}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} ADF pipeline run(s) did not succeed:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<PollAdfPipelineRunsConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
