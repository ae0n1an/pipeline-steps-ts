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
