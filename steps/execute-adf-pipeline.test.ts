import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './execute-adf-pipeline';
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

test('runAll triggers pipelines and returns flattened outputs, no polling', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-adf-test-'));
  try {
    const fetchImpl: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({ runId: url.includes('copyA') ? 'run-a' : 'run-b' }),
      text: async () => '',
    });
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
    assert.equal(result.outputs?.copyA_status, 'Triggered');
    assert.equal(result.outputs?.copyA_runId, 'run-a');
    assert.equal(result.outputs?.p1_pipelineName, 'copyB');
    assert.ok(fs.existsSync(path.join(outDir, 'execution-summary.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll passes existingRunId through without calling createRun', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-adf-test-'));
  try {
    let createRunCalls = 0;
    const fetchImpl: FetchLike = async () => {
      createRunCalls += 1;
      return { ok: true, status: 200, json: async () => ({ runId: 'should-not-happen' }), text: async () => '' };
    };
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pipelines: [{ name: 'copyA', pipelineName: 'copyA', existingRunId: 'run-auto-1' }],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(createRunCalls, 0);
    assert.equal(result.outputs?.copyA_runId, 'run-auto-1');
    assert.equal(result.outputs?.copyA_status, 'PassedThrough');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws an aggregated error when a pipeline fails to trigger', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-adf-test-'));
  try {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'Forbidden' });
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
      /1\/1 ADF pipeline\(s\) failed to trigger[\s\S]*copyC[\s\S]*HTTP 403/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll validates required config upfront', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-adf-test-'));
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
