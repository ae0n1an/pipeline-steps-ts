import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './verify-row-count';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('counts CSV rows excluding the header and passes when within range', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    const csvPath = path.join(outDir, 'data.csv');
    fs.writeFileSync(csvPath, 'id,name\n1,Alice\n2,Bob\n3,Carla\n');
    const config = { files: [{ name: 'data', filePath: csvPath, minRows: 2, maxRows: 5 }] };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.data_rowCount, 3);
    assert.equal(result.outputs?.data_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('counts a JSON top-level array by length', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    const jsonPath = path.join(outDir, 'data.json');
    fs.writeFileSync(jsonPath, JSON.stringify([{ a: 1 }, { a: 2 }]));
    const config = { files: [{ name: 'data', filePath: jsonPath }] };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.data_rowCount, 2);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails an entry whose row count is below minRows', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    const csvPath = path.join(outDir, 'data.csv');
    fs.writeFileSync(csvPath, 'id\n1\n');
    const config = { files: [{ name: 'tooFew', filePath: csvPath, minRows: 5 }] };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("tooFew"\) failed:.*below minRows/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails an entry whose row count is above maxRows', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    const csvPath = path.join(outDir, 'data.csv');
    fs.writeFileSync(csvPath, 'id\n1\n2\n3\n');
    const config = { files: [{ name: 'tooMany', filePath: csvPath, maxRows: 1 }] };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("tooMany"\) failed:.*above maxRows/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast on the first invalid entry without checking the rest', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    const badPath = path.join(outDir, 'missing.csv');
    const goodPath = path.join(outDir, 'good.csv');
    fs.writeFileSync(goodPath, 'id\n1\n');
    const config = {
      files: [
        { name: 'bad', filePath: badPath },
        { name: 'good', filePath: goodPath },
      ],
    };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("bad"\) failed:.*not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowcount-test-'));
  try {
    assert.throws(
      () => runAll({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
