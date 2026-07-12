import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import step from './generate-synthetic-csv';
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

test('generates a single named file with the requested row count', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  try {
    const config = {
      files: [
        {
          name: 'usersCsv',
          fileName: 'users.csv',
          rowCount: 5,
          seed: 1,
          columns: [{ name: 'id', type: 'uuid' as const }],
        },
      ],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.totalFiles, 1);
    assert.equal(result.outputs?.usersCsv_fileName, 'users.csv');
    assert.equal(result.outputs?.usersCsv_rowCount, 5);
    const filePath = result.outputs?.usersCsv_csvPath as string;
    assert.ok(fs.existsSync(filePath));
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 6); // header + 5 rows
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('generates multiple files with distinct default names and no path collisions', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  try {
    const config = {
      files: [
        { rowCount: 2, seed: 1, columns: [{ name: 'id', type: 'uuid' as const }] },
        { rowCount: 3, seed: 2, columns: [{ name: 'id', type: 'uuid' as const }] },
      ],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.totalFiles, 2);
    assert.equal(result.outputs?.f0_fileName, 'synthetic-0.csv');
    assert.equal(result.outputs?.f1_fileName, 'synthetic-1.csv');
    assert.notEqual(result.outputs?.f0_csvPath, result.outputs?.f1_csvPath);
    const rows0 = fs.readFileSync(result.outputs?.f0_csvPath as string, 'utf8').trim().split('\n');
    const rows1 = fs.readFileSync(result.outputs?.f1_csvPath as string, 'utf8').trim().split('\n');
    assert.equal(rows0.length, 3); // header + 2 rows
    assert.equal(rows1.length, 4); // header + 3 rows
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast on the first invalid entry, naming it in the error, after writing prior entries', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  try {
    const config = {
      files: [
        { name: 'good', rowCount: 1, seed: 1, columns: [{ name: 'id', type: 'uuid' as const }] },
        { name: 'bad', rowCount: 1, columns: [] },
      ],
    };
    await assert.rejects(
      async () => step.run(config, fakeCtx(outDir)),
      /File entry 1 \("bad"\) failed:.*columns/,
    );
    assert.ok(fs.readdirSync(outDir).includes('synthetic-0.csv'));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('uses a column\'s custom header in the CSV header row and in columnNames, falling back to name otherwise', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  try {
    const config = {
      files: [
        {
          name: 'usersCsv',
          rowCount: 1,
          seed: 1,
          columns: [
            { name: 'id', header: 'ID Number', type: 'uuid' as const },
            { name: 'email', type: 'email' as const },
          ],
        },
      ],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.usersCsv_columnNames, 'ID Number,email');
    const filePath = result.outputs?.usersCsv_csvPath as string;
    const [headerLine] = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(headerLine, 'ID Number,email');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  try {
    await assert.rejects(
      async () => step.run({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
