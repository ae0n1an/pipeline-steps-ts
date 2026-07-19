import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTarget,
  buildPipelineRunUrl,
  buildQueryActivityRunsUrl,
  deriveActivityWindow,
} from './extract-adf-run-details';

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
