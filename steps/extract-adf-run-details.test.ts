import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTarget,
  buildPipelineRunUrl,
  buildQueryActivityRunsUrl,
  deriveActivityWindow,
} from './extract-adf-run-details';
import { getPipelineRun, queryActivityRuns, extractPipelineRunRecursive, type FetchLike } from './extract-adf-run-details';

test('resolveTarget uses per-entry fields when present', () => {
  const target = resolveTarget(
    { runId: 'r1', subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    { accessToken: 't', runs: [] },
  );
  assert.deepEqual(target, { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
});

test('resolveTarget falls back to top-level config defaults', () => {
  const target = resolveTarget(
    { runId: 'r1' },
    { accessToken: 't', runs: [], subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
  );
  assert.deepEqual(target, { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' });
});

test('resolveTarget throws when a coordinate is missing everywhere', () => {
  assert.throws(
    () => resolveTarget({ runId: 'r1' }, { accessToken: 't', runs: [], subscriptionId: 'sub1' }),
    /missing subscriptionId\/resourceGroup\/factoryName/,
  );
});

test('buildPipelineRunUrl builds the ADF get-pipeline-run endpoint', () => {
  const url = buildPipelineRunUrl(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    'run-123',
  );
  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DataFactory/factories/f1/pipelineruns/run-123?api-version=2018-06-01',
  );
});

test('buildQueryActivityRunsUrl builds the ADF query-activity-runs endpoint', () => {
  const url = buildQueryActivityRunsUrl(
    { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' },
    'run-123',
  );
  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DataFactory/factories/f1/pipelineruns/run-123/queryActivityruns?api-version=2018-06-01',
  );
});

test('deriveActivityWindow pads runStart/runEnd by one minute each side', () => {
  const window = deriveActivityWindow({ runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:10:00.000Z' });
  assert.equal(new Date(window.lastUpdatedAfter).getTime(), new Date('2026-01-01T00:00:00.000Z').getTime() - 60_000);
  assert.equal(new Date(window.lastUpdatedBefore).getTime(), new Date('2026-01-01T00:10:00.000Z').getTime() + 60_000);
});

test('deriveActivityWindow falls back to "now" padded by a minute when runEnd is absent', () => {
  const before = Date.now();
  const window = deriveActivityWindow({ runStart: '2026-01-01T00:00:00.000Z' });
  const after = Date.now();
  const windowEndMs = new Date(window.lastUpdatedBefore).getTime();
  assert.ok(windowEndMs >= before + 60_000 - 1000 && windowEndMs <= after + 60_000 + 1000);
});

const TARGET = { subscriptionId: 'sub1', resourceGroup: 'rg1', factoryName: 'f1' };

test('getPipelineRun returns parsed pipeline run data', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ runId: 'run-1', pipelineName: 'CopyOrders', status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z', durationInMs: 300000 }),
    text: async () => '',
  });
  const run = await getPipelineRun(TARGET, 'run-1', 'token', fetchImpl);
  assert.equal(run.pipelineName, 'CopyOrders');
  assert.equal(run.status, 'Succeeded');
});

test('getPipelineRun throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' });
  await assert.rejects(
    () => getPipelineRun(TARGET, 'run-1', 'token', fetchImpl),
    /HTTP 404[\s\S]*Not Found/,
  );
});

test('queryActivityRuns returns activities from a single page', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: '2026-01-01T00:01:00.000Z', durationInMs: 1000 }] }),
    text: async () => '',
  });
  const activities = await queryActivityRuns(TARGET, 'run-1', 'token', { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' }, fetchImpl);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].activityName, 'Copy1');
});

test('queryActivityRuns follows continuationToken across multiple pages', async () => {
  let call = 0;
  const bodies: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    call += 1;
    bodies.push(init?.body ?? '');
    if (call === 1) {
      return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't1' }], continuationToken: 'tok-2' }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: 'a2', activityName: 'Copy2', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't2' }] }), text: async () => '' };
  };
  const activities = await queryActivityRuns(TARGET, 'run-1', 'token', { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' }, fetchImpl);
  assert.deepEqual(activities.map(a => a.activityRunId), ['a1', 'a2']);
  assert.equal(call, 2);
  assert.equal(JSON.parse(bodies[0]).continuationToken, undefined);
  assert.equal(JSON.parse(bodies[1]).continuationToken, 'tok-2');
});

test('queryActivityRuns throws with status and body on non-2xx', async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
  await assert.rejects(
    () => queryActivityRuns(TARGET, 'run-1', 'token', { lastUpdatedAfter: 'a', lastUpdatedBefore: 'b' }, fetchImpl),
    /HTTP 500[\s\S]*boom/,
  );
});

test('extractPipelineRunRecursive returns just the run and its activities when there are no ExecutePipeline activities', async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('queryActivityruns')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't1' }] }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ runId: 'run-1', pipelineName: 'CopyOrders', status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z' }), text: async () => '' };
  };
  const result = await extractPipelineRunRecursive(TARGET, 'run-1', null, 'token', fetchImpl, 5, 0);
  assert.equal(result.pipelineRuns.length, 1);
  assert.equal(result.pipelineRuns[0].truncated, undefined);
  assert.equal(result.activities.length, 1);
});

test('extractPipelineRunRecursive recurses into a child pipeline run invoked via ExecutePipeline', async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('queryActivityruns')) {
      if (url.includes('run-1/')) {
        return {
          ok: true, status: 200,
          json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'CallChild', activityType: 'ExecutePipeline', status: 'Succeeded', activityRunStart: 't1', output: { pipelineRunId: 'run-2' } }] }),
          text: async () => '',
        };
      }
      return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: 'a2', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't2' }] }), text: async () => '' };
    }
    if (url.includes('run-2')) {
      return { ok: true, status: 200, json: async () => ({ runId: 'run-2', pipelineName: 'ChildPipeline', status: 'Succeeded', runStart: '2026-01-01T00:01:00.000Z', runEnd: '2026-01-01T00:02:00.000Z' }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ runId: 'run-1', pipelineName: 'ParentPipeline', status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z' }), text: async () => '' };
  };
  const result = await extractPipelineRunRecursive(TARGET, 'run-1', null, 'token', fetchImpl, 5, 0);
  assert.equal(result.pipelineRuns.length, 2);
  const child = result.pipelineRuns.find(r => r.runId === 'run-2');
  assert.equal(child?.parentRunId, 'run-1');
  assert.equal(result.activities.length, 2);
});

test('extractPipelineRunRecursive stops descending at maxDepth and marks truncated, but still captures that run\'s own activities', async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('queryActivityruns')) {
      return {
        ok: true, status: 200,
        json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'CallChild', activityType: 'ExecutePipeline', status: 'Succeeded', activityRunStart: 't1', output: { pipelineRunId: 'run-2' } }] }),
        text: async () => '',
      };
    }
    return { ok: true, status: 200, json: async () => ({ runId: 'run-1', pipelineName: 'ParentPipeline', status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z' }), text: async () => '' };
  };
  // maxDepth 0 means depth 0 (this call) is already at the cap.
  const result = await extractPipelineRunRecursive(TARGET, 'run-1', null, 'token', fetchImpl, 0, 0);
  assert.equal(result.pipelineRuns.length, 1);
  assert.equal(result.pipelineRuns[0].truncated, true);
  assert.equal(result.activities.length, 1); // the ExecutePipeline activity itself is still captured
});

test('extractPipelineRunRecursive does not mark truncated when maxDepth is reached but there are no ExecutePipeline activities to follow', async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('queryActivityruns')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: 'a1', activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't1' }] }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ runId: 'run-1', pipelineName: 'LeafPipeline', status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z' }), text: async () => '' };
  };
  const result = await extractPipelineRunRecursive(TARGET, 'run-1', null, 'token', fetchImpl, 0, 0);
  assert.equal(result.pipelineRuns[0].truncated, undefined);
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './extract-adf-run-details';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

function fakeFetchForRun(runId: string, pipelineName: string): FetchLike {
  return async (url) => {
    if (url.includes('queryActivityruns')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ activityRunId: `${runId}-a1`, activityName: 'Copy1', activityType: 'Copy', status: 'Succeeded', activityRunStart: 't1' }] }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ runId, pipelineName, status: 'Succeeded', runStart: '2026-01-01T00:00:00.000Z', runEnd: '2026-01-01T00:05:00.000Z', durationInMs: 300000 }), text: async () => '' };
  };
}

test('runAll extracts a single run end-to-end and writes adf-run-details.json', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adfdetails-test-'));
  try {
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      runs: [{ name: 'copyOrders', runId: 'run-1' }],
    };
    const result = await runAll(config, fakeCtx(outDir), fakeFetchForRun('run-1', 'CopyOrders'));
    assert.equal(result.outputs?.totalRuns, 1);
    assert.equal(result.outputs?.copyOrders_status, 'Succeeded');
    assert.equal(result.outputs?.copyOrders_durationMs, 300000);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'adf-run-details.json'), 'utf8'));
    assert.equal(summary.pipelineRuns.length, 1);
    assert.equal(summary.activities.length, 1);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll processes multiple runs concurrently; one failure does not block a sibling', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adfdetails-test-'));
  try {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('run-bad')) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' };
      }
      return fakeFetchForRun('run-good', 'GoodPipeline')(url);
    };
    const config = {
      accessToken: 't',
      subscriptionId: 'sub1',
      resourceGroup: 'rg1',
      factoryName: 'f1',
      runs: [
        { name: 'good', runId: 'run-good' },
        { name: 'bad', runId: 'run-bad' },
      ],
    };
    await assert.rejects(
      () => runAll(config, fakeCtx(outDir), fetchImpl),
      /1\/2 ADF run\(s\) failed to extract[\s\S]*bad[\s\S]*Failed/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws when config.accessToken is missing', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adfdetails-test-'));
  try {
    await assert.rejects(
      () => runAll({ accessToken: '', runs: [{ runId: 'r1' }] } as any, fakeCtx(outDir), fakeFetchForRun('r1', 'X')),
      /accessToken is required/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll throws when config.runs is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adfdetails-test-'));
  try {
    await assert.rejects(
      () => runAll({ accessToken: 't', runs: [] }, fakeCtx(outDir), fakeFetchForRun('r1', 'X')),
      /config\.runs must contain at least one run/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
