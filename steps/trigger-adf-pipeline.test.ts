import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTarget,
  buildCreateRunUrl,
  buildPollUrl,
  isTerminalStatus,
} from './trigger-adf-pipeline';
import { triggerRun, pollUntilTerminal, type AdfDeps, type FetchLike } from './trigger-adf-pipeline';

test('resolveTarget uses per-run fields when present', () => {
  const target = resolveTarget(
    { pipelineName: 'p', subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    { accessToken: 't', pipelines: [] },
  );
  assert.deepEqual(target, { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
});

test('resolveTarget falls back to top-level config defaults', () => {
  const target = resolveTarget(
    { pipelineName: 'p' },
    { accessToken: 't', pipelines: [], subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
  );
  assert.deepEqual(target, { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
});

test('resolveTarget throws when a coordinate is missing everywhere', () => {
  assert.throws(
    () => resolveTarget({ pipelineName: 'p' }, { accessToken: 't', pipelines: [], subscriptionId: 'sub1' }),
    /missing subscriptionId\/resourceGroup\/factoryName/,
  );
});

test('buildCreateRunUrl builds the ADF createRun endpoint', () => {
  const url = buildCreateRunUrl(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    'copyOrders',
  );
  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DataFactory/factories/f1/pipelines/copyOrders/createRun?api-version=2018-06-01',
  );
});

test('buildPollUrl builds the ADF pipelineruns endpoint', () => {
  const url = buildPollUrl(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    'run-123',
  );
  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DataFactory/factories/f1/pipelineruns/run-123?api-version=2018-06-01',
  );
});

test('isTerminalStatus recognizes terminal and non-terminal states', () => {
  assert.equal(isTerminalStatus('Succeeded'), true);
  assert.equal(isTerminalStatus('Failed'), true);
  assert.equal(isTerminalStatus('Cancelled'), true);
  assert.equal(isTerminalStatus('TimedOut'), true);
  assert.equal(isTerminalStatus('InProgress'), false);
  assert.equal(isTerminalStatus('Queued'), false);
});

function fakeClock(overrides: Partial<AdfDeps> = {}): AdfDeps {
  let clock = 0;
  return {
    fetchImpl: overrides.fetchImpl ?? (async () => { throw new Error('fetchImpl not stubbed'); }),
    sleepImpl: overrides.sleepImpl ?? (async (ms: number) => { clock += ms; }),
    nowImpl: overrides.nowImpl ?? (() => clock),
  };
}

test('triggerRun posts parameters and returns runId', async () => {
  let capturedUrl = '';
  let capturedBody = '';
  const fetchImpl: FetchLike = async (url, init) => {
    capturedUrl = url;
    capturedBody = init?.body ?? '';
    return { ok: true, status: 200, json: async () => ({ runId: 'run-abc' }), text: async () => '' };
  };
  const runId = await triggerRun(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    { pipelineName: 'copyOrders', parameters: { x: 1 } },
    'token-123',
    fetchImpl,
  );
  assert.equal(runId, 'run-abc');
  assert.match(capturedUrl, /pipelines\/copyOrders\/createRun/);
  assert.equal(capturedBody, JSON.stringify({ x: 1 }));
});

test('triggerRun throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: false,
    status: 403,
    json: async () => ({}),
    text: async () => 'Forbidden',
  });
  await assert.rejects(
    () => triggerRun({ subscriptionId: 's', resourceGroup: 'r', factoryName: 'f' }, { pipelineName: 'p' }, 't', fetchImpl),
    /HTTP 403[\s\S]*Forbidden/,
  );
});

test('pollUntilTerminal returns once status is terminal', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: calls < 3 ? 'InProgress' : 'Succeeded' }),
      text: async () => '',
    };
  };
  const deps = fakeClock({ fetchImpl });
  const outcome = await pollUntilTerminal(
    { subscriptionId: 's', resourceGroup: 'r', factoryName: 'f' },
    'run-1',
    't',
    { pollIntervalMs: 1000, timeoutMs: 60000 },
    deps,
  );
  assert.equal(outcome.status, 'Succeeded');
  assert.equal(calls, 3);
});

test('pollUntilTerminal times out and reports TimedOut', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'InProgress' }),
    text: async () => '',
  });
  const deps = fakeClock({ fetchImpl });
  const outcome = await pollUntilTerminal(
    { subscriptionId: 's', resourceGroup: 'r', factoryName: 'f' },
    'run-1',
    't',
    { pollIntervalMs: 1000, timeoutMs: 2500 },
    deps,
  );
  assert.equal(outcome.status, 'TimedOut');
});

test('pollUntilTerminal retries past a transient non-2xx response', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({}), text: async () => 'throttled' };
    return { ok: true, status: 200, json: async () => ({ status: 'Succeeded' }), text: async () => '' };
  };
  const deps = fakeClock({ fetchImpl });
  const outcome = await pollUntilTerminal(
    { subscriptionId: 's', resourceGroup: 'r', factoryName: 'f' },
    'run-1',
    't',
    { pollIntervalMs: 1000, timeoutMs: 60000 },
    deps,
  );
  assert.equal(outcome.status, 'Succeeded');
  assert.equal(calls, 2);
});
