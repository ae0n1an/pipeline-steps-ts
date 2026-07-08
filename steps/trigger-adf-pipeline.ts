/**
 * Step: trigger-adf-pipeline (TypeScript)
 *
 * Triggers one or more Azure Data Factory pipeline runs in parallel and
 * polls each to completion. Auth is a bearer token fetched by an
 * AzureCLI@2 task upstream in the pipeline YAML and mapped into this
 * step's env (config.accessToken -> "{{env.ADF_ACCESS_TOKEN}}").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';

const API_VERSION = '2018-06-01';
const TERMINAL_STATUSES = new Set(['Succeeded', 'Failed', 'Cancelled', 'TimedOut']);

// ---------- Config types --------------------------------------------------

export interface AdfPipelineRun {
  /** Friendly key used for this run's output fields; defaults to "p{index}". */
  name?: string;
  pipelineName: string;
  parameters?: Record<string, unknown>;
  /** Per-run overrides; fall back to the top-level config defaults. */
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export interface TriggerAdfPipelineConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** Poll interval while waiting for a run to finish. Default 15000. */
  pollIntervalMs?: number | string;
  /** Max time to wait for a single run before treating it as failed. Default 3600000 (1h). */
  timeoutMs?: number | string;
  pipelines: AdfPipelineRun[];
}

export interface AdfTarget {
  subscriptionId: string;
  resourceGroup: string;
  factoryName: string;
}

export interface RunResult {
  name: string;
  pipelineName: string;
  runId?: string;
  status: string;
  durationMs: number;
  message?: string;
}

// ---------- Pure helpers ---------------------------------------------------

export function resolveTarget(run: AdfPipelineRun, config: TriggerAdfPipelineConfig): AdfTarget {
  const subscriptionId = run.subscriptionId ?? config.subscriptionId;
  const resourceGroup = run.resourceGroup ?? config.resourceGroup;
  const factoryName = run.factoryName ?? config.factoryName;
  if (!subscriptionId || !resourceGroup || !factoryName) {
    throw new Error(
      `Pipeline run "${run.pipelineName}" is missing subscriptionId/resourceGroup/factoryName ` +
      '(set them per-run or as top-level config defaults)',
    );
  }
  return { subscriptionId, resourceGroup, factoryName };
}

export function buildCreateRunUrl(target: AdfTarget, pipelineName: string): string {
  return `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DataFactory/factories/${target.factoryName}/pipelines/${pipelineName}/createRun?api-version=${API_VERSION}`;
}

export function buildPollUrl(target: AdfTarget, runId: string): string {
  return `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DataFactory/factories/${target.factoryName}/pipelineruns/${runId}?api-version=${API_VERSION}`;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------- Network layer (dependency-injected for testing) ---------------

export interface FetchLike {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;
}

export interface AdfDeps {
  fetchImpl: FetchLike;
  sleepImpl: (ms: number) => Promise<void>;
  nowImpl: () => number;
}

export const defaultDeps: AdfDeps = {
  fetchImpl: fetch as unknown as FetchLike,
  sleepImpl: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
  nowImpl: () => Date.now(),
};

export async function triggerRun(
  target: AdfTarget,
  run: AdfPipelineRun,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const res = await fetchImpl(buildCreateRunUrl(target, run.pipelineName), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(run.parameters ?? {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`createRun failed for "${run.pipelineName}" (HTTP ${res.status}): ${body}`);
  }
  const data = await res.json();
  if (!data.runId) throw new Error(`createRun response for "${run.pipelineName}" had no runId`);
  return data.runId as string;
}

export async function pollUntilTerminal(
  target: AdfTarget,
  runId: string,
  accessToken: string,
  opts: { pollIntervalMs: number; timeoutMs: number },
  deps: AdfDeps,
): Promise<{ status: string; message?: string }> {
  const startedAt = deps.nowImpl();
  for (;;) {
    if (deps.nowImpl() - startedAt >= opts.timeoutMs) {
      return { status: 'TimedOut', message: `Polling exceeded timeoutMs=${opts.timeoutMs}` };
    }
    const res = await deps.fetchImpl(buildPollUrl(target, runId), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (isTerminalStatus(data.status)) {
        return { status: data.status, message: data.message };
      }
    }
    await deps.sleepImpl(opts.pollIntervalMs);
  }
}

// ---------- Orchestration ---------------------------------------------------

function outputKeyPrefix(run: AdfPipelineRun, index: number): string {
  return run.name ?? `p${index}`;
}

async function runOnePipeline(
  run: AdfPipelineRun,
  index: number,
  config: TriggerAdfPipelineConfig,
  deps: AdfDeps,
  ctx: StepContext,
): Promise<RunResult> {
  const name = outputKeyPrefix(run, index);
  const startedAt = deps.nowImpl();
  try {
    const target = resolveTarget(run, config);
    const runId = await triggerRun(target, run, config.accessToken, deps.fetchImpl);
    ctx.log(`Triggered "${run.pipelineName}" (${name}) -> runId=${runId}`);
    const outcome = await pollUntilTerminal(
      target,
      runId,
      config.accessToken,
      {
        pollIntervalMs: Number(config.pollIntervalMs ?? 15000),
        timeoutMs: Number(config.timeoutMs ?? 3600000),
      },
      deps,
    );
    return {
      name,
      pipelineName: run.pipelineName,
      runId,
      status: outcome.status,
      durationMs: deps.nowImpl() - startedAt,
      message: outcome.message,
    };
  } catch (err) {
    return {
      name,
      pipelineName: run.pipelineName,
      status: 'Failed',
      durationMs: deps.nowImpl() - startedAt,
      message: (err as Error).message,
    };
  }
}

export async function runAll(
  config: TriggerAdfPipelineConfig,
  ctx: StepContext,
  deps: AdfDeps = defaultDeps,
): Promise<StepResult> {
  if (!config.accessToken) throw new Error('config.accessToken is required');
  if (!config.pipelines || config.pipelines.length === 0) {
    throw new Error('config.pipelines must contain at least one pipeline run');
  }
  config.pipelines.forEach((run, i) => {
    if (!run.pipelineName) throw new Error(`config.pipelines[${i}] is missing pipelineName`);
  });

  const results = await Promise.all(
    config.pipelines.map((run, index) => runOnePipeline(run, index, config, deps, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'run-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const failed = results.filter(r => r.status !== 'Succeeded');
  const outputs: Record<string, string | number | boolean> = {
    totalPipelines: results.length,
    succeededCount: results.length - failed.length,
    failedCount: failed.length,
  };
  for (const r of results) {
    outputs[`${r.name}_runId`] = r.runId ?? '';
    outputs[`${r.name}_status`] = r.status;
    outputs[`${r.name}_pipelineName`] = r.pipelineName;
    outputs[`${r.name}_durationMs`] = r.durationMs;
  }

  if (failed.length > 0) {
    const detail = failed
      .map(r => `  - ${r.name} (${r.pipelineName}, runId=${r.runId ?? 'n/a'}): ${r.status}${r.message ? ` — ${r.message}` : ''}`)
      .join('\n');
    throw new Error(`${failed.length}/${results.length} ADF pipeline run(s) did not succeed:\n${detail}`);
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<TriggerAdfPipelineConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
