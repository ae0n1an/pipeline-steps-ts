import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsolidatedResult } from './consolidate-run-results';
import type { StepOutputFile } from '../runner/types';

function fakeStepOutput(overrides: Partial<StepOutputFile> = {}): StepOutputFile {
  return {
    step: 'x',
    ok: true,
    durationMs: 10,
    outputs: {},
    artifacts: [],
    ...overrides,
  };
}

test('buildConsolidatedResult includes each named step with its outputs and ok status', () => {
  const steps = {
    genUsersCsv: fakeStepOutput({ ok: true, outputs: { usersCsv_rowCount: 250 } }),
  };
  const result = buildConsolidatedResult({ stepNames: ['genUsersCsv'] }, steps, () => '2026-07-20T00:00:00.000Z');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].stepName, 'genUsersCsv');
  assert.equal(result.steps[0].ok, true);
  assert.deepEqual(result.steps[0].outputs, { usersCsv_rowCount: 250 });
  assert.equal(result.steps[0].error, undefined);
  assert.equal(result.generatedAt, '2026-07-20T00:00:00.000Z');
});

test('buildConsolidatedResult includes a failed step with its error message, not throwing', () => {
  const steps = {
    extractAdfDetails: fakeStepOutput({ ok: false, outputs: {}, error: { message: 'boom', stack: 'at ...' } }),
  };
  const result = buildConsolidatedResult({ stepNames: ['extractAdfDetails'] }, steps);
  assert.equal(result.steps[0].ok, false);
  assert.equal(result.steps[0].error, 'boom');
});

test('buildConsolidatedResult computes summary counts correctly', () => {
  const steps = {
    a: fakeStepOutput({ ok: true }),
    b: fakeStepOutput({ ok: false, error: { message: 'e' } }),
    c: fakeStepOutput({ ok: true }),
  };
  const result = buildConsolidatedResult({ stepNames: ['a', 'b', 'c'] }, steps);
  assert.deepEqual(result.summary, { totalSteps: 3, succeededCount: 2, failedCount: 1 });
});

test('buildConsolidatedResult passes runMetadata through as-is, defaulting to an empty object', () => {
  const steps = { a: fakeStepOutput() };
  const withMeta = buildConsolidatedResult({ stepNames: ['a'], runMetadata: { buildId: '123' } }, steps);
  assert.deepEqual(withMeta.runMetadata, { buildId: '123' });
  const withoutMeta = buildConsolidatedResult({ stepNames: ['a'] }, steps);
  assert.deepEqual(withoutMeta.runMetadata, {});
});

test("buildConsolidatedResult throws naming every step not present in this run's step outputs", () => {
  const steps = { a: fakeStepOutput() };
  assert.throws(
    () => buildConsolidatedResult({ stepNames: ['a', 'missing1', 'missing2'] }, steps),
    /missing1, missing2/,
  );
});

test('buildConsolidatedResult throws when config.stepNames is empty', () => {
  assert.throws(
    () => buildConsolidatedResult({ stepNames: [] }, {}),
    /config\.stepNames must contain at least one step name/,
  );
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './consolidate-run-results';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string, steps: Record<string, StepOutputFile>): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps, log: () => {}, warn: () => {} };
}

test('runAll writes the consolidated JSON artifact and returns summary outputs', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-test-'));
  try {
    const steps = {
      genUsersCsv: fakeStepOutput({ ok: true, outputs: { usersCsv_rowCount: 250 } }),
    };
    const config = { stepNames: ['genUsersCsv'] };
    const result = runAll(config, fakeCtx(outDir, steps));
    assert.equal(result.outputs?.totalSteps, 1);
    assert.equal(result.outputs?.succeededCount, 1);
    assert.equal(result.outputs?.failedCount, 0);
    const filePath = result.outputs?.consolidatedPath as string;
    assert.ok(fs.existsSync(filePath));
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.steps[0].stepName, 'genUsersCsv');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll uses a custom fileName when configured', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-test-'));
  try {
    const steps = { a: fakeStepOutput() };
    const result = runAll({ stepNames: ['a'], fileName: 'custom-report.json' }, fakeCtx(outDir, steps));
    assert.ok((result.outputs?.consolidatedPath as string).endsWith('custom-report.json'));
    assert.ok(fs.existsSync(path.join(outDir, 'custom-report.json')));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('runAll propagates a missing-step-name error without writing a file', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-test-'));
  try {
    assert.throws(
      () => runAll({ stepNames: ['missing'] }, fakeCtx(outDir, {})),
      /missing/,
    );
    assert.deepEqual(fs.readdirSync(outDir), []);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
