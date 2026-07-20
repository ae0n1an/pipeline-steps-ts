/**
 * Shared Azure Data Factory REST client used by execute-adf-pipeline,
 * poll-adf-pipeline-runs, and wait-for-adf-pipeline-trigger. Not shared
 * with extract-adf-run-details.ts — see that step's file header for why;
 * the overlap there (URL prefix, auth header) is too small to justify
 * touching already-shipped, tested code.
 */

const API_VERSION = '2018-06-01';
const TERMINAL_STATUSES = new Set(['Succeeded', 'Failed', 'Cancelled', 'TimedOut']);

export interface AdfTarget {
  subscriptionId: string;
  resourceGroup: string;
  factoryName: string;
}

export interface AdfTargetSource {
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}

export function resolveTarget(entry: AdfTargetSource, config: AdfTargetSource, label: string): AdfTarget {
  const subscriptionId = entry.subscriptionId ?? config.subscriptionId;
  const resourceGroup = entry.resourceGroup ?? config.resourceGroup;
  const factoryName = entry.factoryName ?? config.factoryName;
  if (!subscriptionId || !resourceGroup || !factoryName) {
    throw new Error(
      `"${label}" is missing subscriptionId/resourceGroup/factoryName ` +
      '(set them per-entry or as top-level config defaults)',
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

export function buildQueryPipelineRunsUrl(target: AdfTarget): string {
  return `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DataFactory/factories/${target.factoryName}/queryPipelineRuns?api-version=${API_VERSION}`;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

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
  pipelineName: string,
  parameters: Record<string, unknown> | undefined,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const res = await fetchImpl(buildCreateRunUrl(target, pipelineName), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(parameters ?? {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`createRun failed for "${pipelineName}" (HTTP ${res.status}): ${body}`);
  }
  const data = await res.json();
  if (!data.runId) throw new Error(`createRun response for "${pipelineName}" had no runId`);
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
