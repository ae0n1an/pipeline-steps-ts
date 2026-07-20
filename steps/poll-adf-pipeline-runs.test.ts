import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './poll-adf-pipeline-runs';
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

test('runAll polls all runs to completion, returns flattened outputs', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-adf-test-'));
  try {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ status: 'Succeeded' }), text: async () => '' });
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      runs: [
        { name: 'copyA', runId: 'run-a', pipelineName: 'copyA' },
        { runId: 'run-b' },
      ],
    };
    const result = await runAll(config, fakeCtx(outDir), deps);
    assert.equal(result.outputs?.totalPipelines, 2);
    assert.equal(result.outputs?.succeededCount, 2);
    assert.equal(result.outputs?.failedCount, 0);
    assert.equal(result.outputs?.copyA_status, 'Succeeded');
    assert.equal(result.outputs?.copyA_pipelineName, 'copyA');
    assert.equal(result.outputs?.p1_status, 'Succeeded');
    assert.equal(result.outputs?.p1_runId, 'run-b');
    assert.equal(result.outputs?.p1_pipelineName, undefined);
    assert.ok(fs.existsSync(path.join(outDir, 'poll-summary.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws an aggregated error when any run does not succeed', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-adf-test-'));
  try {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ status: 'Failed', message: 'boom' }), text: async () => '' });
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      runs: [{ runId: 'run-x', pipelineName: 'copyC' }],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), deps),
      /1\/1 ADF pipeline run\(s\) did not succeed[\s\S]*run-x[\s\S]*Failed/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll polls a mixed batch to completion: one success does not abort a sibling failure', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-adf-test-'));
  try {
    let goodPolls = 0;
    const fetchImpl: FetchLike = async (url) => {
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
      runs: [
        { name: 'copyGood', runId: 'run-good' },
        { name: 'copyBad', runId: 'run-bad' },
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), deps),
      /1\/2 ADF pipeline run\(s\) did not succeed[\s\S]*copyBad[\s\S]*run-bad[\s\S]*Failed/,
    );
    assert.equal(goodPolls, 1);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'poll-summary.json'), 'utf8'));
    assert.equal(summary.find((r: { name: string }) => r.name === 'copyGood').status, 'Succeeded');
    assert.equal(summary.find((r: { name: string }) => r.name === 'copyBad').status, 'Failed');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll times out a run that never reaches a terminal status', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-adf-test-'));
  try {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ status: 'InProgress' }), text: async () => '' });
    const deps = fakeClock({ fetchImpl });
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      pollIntervalMs: 1000,
      timeoutMs: 2500,
      runs: [{ runId: 'run-x' }],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), deps),
      /1\/1 ADF pipeline run\(s\) did not succeed[\s\S]*TimedOut/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll validates required config upfront', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-adf-test-'));
  try {
    await assert.rejects(
      () => runAll({ accessToken: '', runs: [] } as any, fakeCtx(outDir), fakeClock()),
      /accessToken is required/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', runs: [] }, fakeCtx(outDir), fakeClock()),
      /at least one run/,
    );
    await assert.rejects(
      () => runAll({ accessToken: 't', runs: [{ runId: '' }] } as any, fakeCtx(outDir), fakeClock()),
      /missing runId/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
