import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTarget,
  buildCreateRunUrl,
  buildPollUrl,
  isTerminalStatus,
} from './trigger-adf-pipeline';

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
