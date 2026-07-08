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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './trigger-adf-pipeline';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return {
    stepName: 'test',
    outDir,
    workspace: outDir,
    steps: {},
    log: () => {},
    warn: () => {},
  };
}

test('runAll triggers and polls all pipelines, returns flattened outputs', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adf-test-'));
  try {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('createRun')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ runId: url.includes('copyA') ? 'run-a' : 'run-b' }),
          text: async () => '',
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'Succeeded' }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pipelines: [
        { name: 'copyA', pipelineName: 'copyA' },
        { pipelineName: 'copyB' },
      ],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(result.outputs?.totalPipelines, 2);
    assert.equal(result.outputs?.succeededCount, 2);
    assert.equal(result.outputs?.failedCount, 0);
    assert.equal(result.outputs?.copyA_status, 'Succeeded');
    assert.equal(result.outputs?.copyA_runId, 'run-a');
    assert.equal(result.outputs?.p1_status, 'Succeeded');
    assert.equal(result.outputs?.p1_pipelineName, 'copyB');
    assert.ok(fs.existsSync(path.join(outDir, 'run-summary.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws an aggregated error when any pipeline does not succeed', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adf-test-'));
  try {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('createRun')) {
        return { ok: true, status: 200, json: async () => ({ runId: 'run-x' }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'Failed', message: 'boom' }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pipelines: [{ pipelineName: 'copyC' }],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), deps),
      /1\/1 ADF pipeline run\(s\) did not succeed[\s\S]*copyC[\s\S]*Failed/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll polls a mixed batch to completion: one success does not abort a sibling failure', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adf-test-'));
  try {
    let goodPolls = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('createRun')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ runId: url.includes('copyGood') ? 'run-good' : 'run-bad' }),
          text: async () => '',
        };
      }
      if (url.includes('run-good')) {
        goodPolls += 1;
        return { ok: true, status: 200, json: async () => ({ status: 'Succeeded' }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'Failed', message: 'boom' }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pipelines: [
        { name: 'copyGood', pipelineName: 'copyGood' },
        { name: 'copyBad', pipelineName: 'copyBad' },
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), deps),
      /1\/2 ADF pipeline run\(s\) did not succeed[\s\S]*copyBad[\s\S]*run-bad[\s\S]*Failed/,
    );
    // The failing sibling must not have prevented copyGood from being polled to completion.
    assert.equal(goodPolls, 1);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'run-summary.json'), 'utf8'));
    assert.equal(summary.find((r: { name: string }) => r.name === 'copyGood').status, 'Succeeded');
    assert.equal(summary.find((r: { name: string }) => r.name === 'copyBad').status, 'Failed');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll validates required config upfront', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adf-test-'));
  try {
    await assert.rejects(
      () => runAll({ accessToken: '', pipelines: [] } as any, fakeCtx(outDir), fakeClock()),
      /accessToken is required/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', pipelines: [] }, fakeCtx(outDir), fakeClock()),
      /at least one pipeline run/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', pipelines: [{ pipelineName: '' }] } as any, fakeCtx(outDir), fakeClock()),
      /missing pipelineName/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
