/**
 * Step: wait-for-adf-pipeline-trigger (TypeScript)
 *
 * Waits to see whether an external scheduler (e.g. Control-M) has already
 * triggered an Azure Data Factory pipeline automatically, by polling ADF's
 * queryPipelineRuns for a matching run started after this step began. If
 * no run appears within waitTimeoutMs, reports triggered:false so the
 * pipeline can fall back to manually triggering it (execute-adf-pipeline.ts)
 * — this supports testing that Control-M's automatic triggers actually
 * fire, with a manual fallback when they don't.
 *
 * Auth is a bearer token fetched by an AzureCLI@2 task upstream in the
 * pipeline YAML and mapped into this step's env
 * (config.accessToken -> "{{env.ADF_ACCESS_TOKEN}}").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';
import {
  resolveTarget,
  buildQueryPipelineRunsUrl,
  type AdfTarget,
  type AdfDeps,
  type FetchLike,
  defaultDeps,
} from './lib/adf-client';

// ---------- Config types --------------------------------------------------

export interface AdfPipelineWait {
  /** Friendly key used for this entry's output fields; defaults to "p{index}". */
  name?: string;
  pipelineName: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export interface WaitForAdfPipelineTriggerConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** How often to re-check queryPipelineRuns while waiting. Default 15000. */
  pollIntervalMs?: number | string;
  /** Max time to wait for an automatic trigger before falling back. Default 600000 (10 min). */
  waitTimeoutMs?: number | string;
  pipelines: AdfPipelineWait[];
}

export interface WaitResult {
  name: string;
  pipelineName: string;
  triggered: boolean;
  runId: string;
  waitedMs: number;
}

// ---------- queryPipelineRuns lookup ----------------------------------------

interface RawPipelineRunSummary {
  runId: string;
}

export async function findAutoTriggeredRun(
  target: AdfTarget,
  pipelineName: string,
  window: { lastUpdatedAfter: string; lastUpdatedBefore: string },
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const res = await fetchImpl(buildQueryPipelineRunsUrl(target), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...window,
      filters: [{ operand: 'PipelineName', operator: 'Equals', values: [pipelineName] }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`queryPipelineRuns failed for "${pipelineName}" (HTTP ${res.status}): ${body}`);
  }
  const data = await res.json();
  const runs = (data.value ?? []) as RawPipelineRunSummary[];
  return runs[0]?.runId;
}

// ---------- Orchestration ---------------------------------------------------

function outputKeyPrefix(entry: AdfPipelineWait, index: number): string {
  return entry.name ?? `p${index}`;
}

async function waitForOnePipeline(
  entry: AdfPipelineWait,
  index: number,
  config: WaitForAdfPipelineTriggerConfig,
  deps: AdfDeps,
  ctx: StepContext,
): Promise<WaitResult> {
  const name = outputKeyPrefix(entry, index);
  const target = resolveTarget(entry, config, entry.pipelineName);
  const pollIntervalMs = Number(config.pollIntervalMs ?? 15000);
  const waitTimeoutMs = Number(config.waitTimeoutMs ?? 600000);

  const startedAt = deps.nowImpl();
  const lastUpdatedAfter = new Date(startedAt - 60_000).toISOString();

  for (;;) {
    const elapsed = deps.nowImpl() - startedAt;
    const lastUpdatedBefore = new Date(deps.nowImpl() + 60_000).toISOString();
    const runId = await findAutoTriggeredRun(
      target,
      entry.pipelineName,
      { lastUpdatedAfter, lastUpdatedBefore },
      config.accessToken,
      deps.fetchImpl,
    );
    if (runId) {
      ctx.log(`Detected automatic trigger for "${entry.pipelineName}" (${name}) -> runId=${runId}`);
      return { name, pipelineName: entry.pipelineName, triggered: true, runId, waitedMs: elapsed };
    }
    if (elapsed >= waitTimeoutMs) {
      ctx.log(`No automatic trigger detected for "${entry.pipelineName}" (${name}) within waitTimeoutMs=${waitTimeoutMs}, falling back`);
      return { name, pipelineName: entry.pipelineName, triggered: false, runId: '', waitedMs: elapsed };
    }
    await deps.sleepImpl(pollIntervalMs);
  }
}

export async function runAll(
  config: WaitForAdfPipelineTriggerConfig,
  ctx: StepContext,
  deps: AdfDeps = defaultDeps,
): Promise<StepResult> {
  if (!config.accessToken) throw new Error('config.accessToken is required');
  if (!config.pipelines || config.pipelines.length === 0) {
    throw new Error('config.pipelines must contain at least one pipeline');
  }
  config.pipelines.forEach((entry, i) => {
    if (!entry.pipelineName) throw new Error(`config.pipelines[${i}] is missing pipelineName`);
  });

  const results = await Promise.all(
    config.pipelines.map((entry, index) => waitForOnePipeline(entry, index, config, deps, ctx)),
  );

  const summaryPath = path.join(ctx.outDir, 'wait-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  const autoTriggeredCount = results.filter(r => r.triggered).length;
  const outputs: Record<string, string | number | boolean> = {
    totalPipelines: results.length,
    autoTriggeredCount,
    fallbackCount: results.length - autoTriggeredCount,
  };
  for (const r of results) {
    outputs[`${r.name}_triggered`] = r.triggered;
    outputs[`${r.name}_runId`] = r.runId;
    outputs[`${r.name}_waitedMs`] = r.waitedMs;
  }

  return { outputs, artifacts: [summaryPath] };
}

export default defineStep<WaitForAdfPipelineTriggerConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
