import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll, findAutoTriggeredRun } from './wait-for-adf-pipeline-trigger';
import type { FetchLike, AdfDeps } from './lib/adf-client';
import type { StepContext } from '../runner/types';

function fakeClock(overrides: Partial<AdfDeps> = {}): AdfDeps {
  let clock = 0;
  return {
    fetchImpl: overrides.fetchImpl ?? (async () => { throw new Error('fetchImpl not stubbed'); }),
    sleepImpl: overrides.sleepImpl ?? (async (ms: number) => { clock += ms; }),
    nowImpl: overrides.nowImpl ?? (() => clock),
  };
}

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

const TARGET = { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' };

test('findAutoTriggeredRun returns the first matching run id', async () => {
  let capturedBody = '';
  const fetchImpl: FetchLike = async (_url, init) => {
    capturedBody = init?.body ?? '';
    return { ok: true, status: 200, json: async () => ({ value: [{ runId: 'run-auto-1' }] }), text: async () => '' };
  };
  const runId = await findAutoTriggeredRun(
    TARGET,
    'CopyOrders',
    { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' },
    'token',
    fetchImpl,
  );
  assert.equal(runId, 'run-auto-1');
  const body = JSON.parse(capturedBody);
  assert.deepEqual(body.filters, [{ operand: 'PipelineName', operator: 'Equals', values: ['CopyOrders'] }]);
});

test('findAutoTriggeredRun returns undefined when no runs match', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' });
  const runId = await findAutoTriggeredRun(TARGET, 'CopyOrders', { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' }, 'token', fetchImpl);
  assert.equal(runId, undefined);
});

test('findAutoTriggeredRun throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
  await assert.rejects(
    () => findAutoTriggeredRun(TARGET, 'CopyOrders', { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' }, 'token', fetchImpl),
    /HTTP 500[\s\S]*boom/,
  );
});

test('runAll reports triggered:true as soon as a matching run is detected', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-adf-test-'));
  try {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ value: calls < 2 ? [] : [{ runId: 'run-auto-1' }] }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pollIntervalMs: 1000,
      waitTimeoutMs: 60000,
      pipelines: [{ name: 'copyOrders', pipelineName: 'CopyOrders' }],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(result.outputs?.totalPipelines, 1);
    assert.equal(result.outputs?.autoTriggeredCount, 1);
    assert.equal(result.outputs?.fallbackCount, 0);
    assert.equal(result.outputs?.copyOrders_triggered, true);
    assert.equal(result.outputs?.copyOrders_runId, 'run-auto-1');
    assert.equal(calls, 2);
    assert.ok(fs.existsSync(path.join(outDir, 'wait-summary.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll reports triggered:false and does not throw when the wait times out', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-adf-test-'));
  try {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' });
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pollIntervalMs: 1000,
      waitTimeoutMs: 2500,
      pipelines: [{ pipelineName: 'CopyOrders' }],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(result.outputs?.autoTriggeredCount, 0);
    assert.equal(result.outputs?.fallbackCount, 1);
    assert.equal(result.outputs?.p0_triggered, false);
    assert.equal(result.outputs?.p0_runId, '');
    assert.ok((result.outputs?.p0_waitedMs as number) >= 2500);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll handles a mixed batch: one pipeline auto-triggers, its sibling falls back', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-adf-test-'));
  try {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}');
      const pipelineName = body.filters[0].values[0];
      if (pipelineName === 'CopyOrders') {
        return { ok: true, status: 200, json: async () => ({ value: [{ runId: 'run-auto-1' }] }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pollIntervalMs: 1000,
      waitTimeoutMs: 1500,
      pipelines: [
        { name: 'copyOrders', pipelineName: 'CopyOrders' },
        { name: 'copyInvoices', pipelineName: 'CopyInvoices' },
      ],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(result.outputs?.autoTriggeredCount, 1);
    assert.equal(result.outputs?.fallbackCount, 1);
    assert.equal(result.outputs?.copyOrders_triggered, true);
    assert.equal(result.outputs?.copyOrders_runId, 'run-auto-1');
    assert.equal(result.outputs?.copyInvoices_triggered, false);
    assert.equal(result.outputs?.copyInvoices_runId, '');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll validates required config upfront', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-adf-test-'));
  try {
    await assert.rejects(
      () => runAll({ accessToken: '', pipelines: [] } as any, fakeCtx(outDir), fakeClock()),
      /accessToken is required/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', pipelines: [] }, fakeCtx(outDir), fakeClock()),
      /at least one pipeline/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', pipelines: [{ pipelineName: '' }] } as any, fakeCtx(outDir), fakeClock()),
      /missing pipelineName/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
