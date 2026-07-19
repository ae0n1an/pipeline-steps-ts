/**
 * Step: extract-adf-run-details (TypeScript)
 *
 * Extracts pipeline- and activity-level detail for a list of Azure Data
 * Factory pipeline run IDs, recursively following any ExecutePipeline
 * activity into the child pipeline run it invoked (up to maxDepth). Auth
 * is a bearer token fetched by the AzureCLI@2 task already used by
 * trigger-adf-pipeline (config.accessToken -> "{{env.ADF_ACCESS_TOKEN}}").
 *
 * Deliberately self-contained rather than sharing a lib with
 * trigger-adf-pipeline.ts — see the design spec's "Not sharing a lib"
 * section; the overlap (URL prefix, auth header) is small enough that
 * retrofitting already-shipped, tested code isn't worth it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult } from '../runner/types';

const API_VERSION = '2018-06-01';

// ---------- Config types ----------------------------------------------------

export interface AdfRunEntry {
  /** Output key prefix for this run's results; defaults to "f{index}". */
  name?: string;
  runId: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export interface ExtractAdfRunDetailsConfig {
  accessToken: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
  /** Safety cap on ExecutePipeline recursion depth; default 5. */
  maxDepth?: number | string;
  runs: AdfRunEntry[];
}

export interface AdfTarget {
  subscriptionId: string;
  resourceGroup: string;
  factoryName: string;
}

export interface PipelineRunDetail {
  runId: string;
  /** null for a top-level run; the parent pipeline run's runId otherwise. */
  parentRunId: string | null;
  pipelineName: string;
  status: string;
  runStart: string;
  runEnd?: string;
  durationMs?: number;
  /** true only if maxDepth was reached AND ExecutePipeline activities were found but not followed. */
  truncated?: boolean;
}

export interface ActivityDetail {
  /** Which pipeline run this activity belongs to. */
  pipelineRunId: string;
  activityId: string;
  activityName: string;
  activityType: string;
  status: string;
  activityRunStart: string;
  durationMs?: number;
}

// ---------- Target resolution ------------------------------------------------

export function resolveTarget(entry: AdfRunEntry, config: ExtractAdfRunDetailsConfig): AdfTarget {
  const subscriptionId = entry.subscriptionId ?? config.subscriptionId;
  const resourceGroup = entry.resourceGroup ?? config.resourceGroup;
  const factoryName = entry.factoryName ?? config.factoryName;
  if (!subscriptionId || !resourceGroup || !factoryName) {
    throw new Error(
      `Run "${entry.runId}" is missing subscriptionId/resourceGroup/factoryName ` +
      '(set them per-run or as top-level config defaults)',
    );
  }
  return { subscriptionId, resourceGroup, factoryName };
}

// ---------- URL building ------------------------------------------------------

export function buildPipelineRunUrl(target: AdfTarget, runId: string): string {
  return `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DataFactory/factories/${target.factoryName}/pipelineruns/${runId}?api-version=${API_VERSION}`;
}

export function buildQueryActivityRunsUrl(target: AdfTarget, runId: string): string {
  return `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DataFactory/factories/${target.factoryName}/pipelineruns/${runId}/queryActivityruns?api-version=${API_VERSION}`;
}

// ---------- Activity time window ----------------------------------------------

export function deriveActivityWindow(pipelineRun: { runStart: string; runEnd?: string }): {
  lastUpdatedAfter: string;
  lastUpdatedBefore: string;
} {
  const start = new Date(pipelineRun.runStart).getTime() - 60_000;
  const endBase = pipelineRun.runEnd ? new Date(pipelineRun.runEnd).getTime() : Date.now();
  const end = endBase + 60_000;
  return {
    lastUpdatedAfter: new Date(start).toISOString(),
    lastUpdatedBefore: new Date(end).toISOString(),
  };
}
