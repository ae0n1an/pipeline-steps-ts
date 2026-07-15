import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  normalizeStepOutput,
  hashFile,
  diffNormalized,
  readGolden,
  writeGolden,
} from './scenario-harness';

test('normalizeStepOutput rewrites absolute paths relative to the workspace root and hashes artifacts', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  try {
    const artifactPath = path.join(workspaceRoot, 'step-output', 'gen', 'users.csv');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'id\n1\n');

    const raw = {
      step: 'gen',
      ok: true,
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 42,
      config: { some: 'input' },
      outputs: { csvPath: artifactPath, rowCount: 1 },
      artifacts: [artifactPath],
    };

    const normalized = normalizeStepOutput(raw, workspaceRoot);
    assert.equal(normalized.ok, true);
    assert.equal(normalized.outputs.csvPath, path.join('step-output', 'gen', 'users.csv'));
    assert.equal(normalized.outputs.rowCount, 1);
    assert.deepEqual(normalized.artifacts, [path.join('step-output', 'gen', 'users.csv')]);
    assert.ok(normalized.fileHashes[path.join('step-output', 'gen', 'users.csv')].startsWith('sha256:'));
    assert.equal('startedAt' in normalized, false);
    assert.equal('durationMs' in normalized, false);
    assert.equal('config' in normalized, false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('normalizeStepOutput keeps only the error message, dropping the stack', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  try {
    const raw = {
      step: 'bad',
      ok: false,
      durationMs: 1,
      error: { message: 'boom', stack: 'Error: boom\n    at ...' },
      outputs: {},
      artifacts: [],
    };
    const normalized = normalizeStepOutput(raw, workspaceRoot);
    assert.equal(normalized.ok, false);
    assert.deepEqual(normalized.error, { message: 'boom' });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('hashFile is deterministic for identical content and differs for different content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  try {
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    fs.writeFileSync(a, 'hello');
    fs.writeFileSync(b, 'hello');
    assert.equal(hashFile(a), hashFile(b));
    fs.writeFileSync(b, 'world');
    assert.notEqual(hashFile(a), hashFile(b));
    assert.match(hashFile(a), /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diffNormalized returns no diffs for identical results', () => {
  const result = { gen: { ok: true, outputs: { a: 1 }, artifacts: [], fileHashes: {} } };
  assert.deepEqual(diffNormalized(result, result), []);
});

test('diffNormalized reports a mismatched output value', () => {
  const actual = { gen: { ok: true, outputs: { rowCount: 5 }, artifacts: [], fileHashes: {} } };
  const golden = { gen: { ok: true, outputs: { rowCount: 4 }, artifacts: [], fileHashes: {} } };
  const diffs = diffNormalized(actual, golden);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /"gen"/);
});

test('diffNormalized reports a step missing from golden or from actual', () => {
  const withExtra = { gen: { ok: true, outputs: {}, artifacts: [], fileHashes: {} }, extra: { ok: true, outputs: {}, artifacts: [], fileHashes: {} } };
  const base = { gen: { ok: true, outputs: {}, artifacts: [], fileHashes: {} } };
  assert.equal(diffNormalized(withExtra, base).length, 1);
  assert.equal(diffNormalized(base, withExtra).length, 1);
});

test('writeGolden then readGolden round-trips the same normalized result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  try {
    const goldenPath = path.join(dir, 'golden', 'scenario.json');
    const result = { gen: { ok: true, outputs: { a: 1 }, artifacts: [], fileHashes: {} } };
    writeGolden(goldenPath, result);
    assert.deepEqual(readGolden(goldenPath), result);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readGolden returns undefined when the golden file does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  try {
    assert.equal(readGolden(path.join(dir, 'nope.json')), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
