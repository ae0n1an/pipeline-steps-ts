import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './validate-business-logic';
import type { ValidateBusinessLogicConfig } from './validate-business-logic';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

test('passes when row counts match, all keys correlate, and fields are equal', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    const csvPath = path.join(outDir, 'inbound.csv');
    const jsonPath = path.join(outDir, 'outbound.json');
    fs.writeFileSync(csvPath, 'id,amount\n1,100\n2,200\n');
    fs.writeFileSync(jsonPath, JSON.stringify([
      { recordId: '1', total: '100' },
      { recordId: '2', total: '200' },
    ]));
    const config: ValidateBusinessLogicConfig = {
      files: [{
        name: 'payload',
        csvPath,
        jsonPath,
        csvKeyField: 'id',
        jsonKeyField: 'recordId',
        rules: [
          { type: 'rowCountMatches' },
          { type: 'allCsvRowsHaveJsonMatch' },
          { type: 'allJsonEntriesHaveCsvMatch' },
          { type: 'fieldsEqual', csvField: 'amount', jsonField: 'total' },
        ],
      }],
    };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.payload_status, 'Succeeded');
    assert.equal(result.outputs?.payload_rulesChecked, 4);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('collects every rule violation for one entry, not just the first', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    const csvPath = path.join(outDir, 'inbound.csv');
    const jsonPath = path.join(outDir, 'outbound.json');
    fs.writeFileSync(csvPath, 'id,amount\n1,100\n2,200\n3,300\n');
    fs.writeFileSync(jsonPath, JSON.stringify([
      { recordId: '1', total: '999' }, // wrong amount
      { recordId: '2', total: '200' },
      // recordId 3 missing entirely, and only 2 json entries vs 3 csv rows
    ]));
    const config: ValidateBusinessLogicConfig = {
      files: [{
        name: 'payload',
        csvPath,
        jsonPath,
        csvKeyField: 'id',
        jsonKeyField: 'recordId',
        rules: [
          { type: 'rowCountMatches' },
          { type: 'allCsvRowsHaveJsonMatch' },
          { type: 'fieldsEqual', csvField: 'amount', jsonField: 'total' },
        ],
      }],
    };
    assert.throws(() => runAll(config, fakeCtx(outDir)), (err: Error) => {
      assert.match(err.message, /File entry 0 \("payload"\) failed:/);
      assert.match(err.message, /rowCountMatches/);
      assert.match(err.message, /allCsvRowsHaveJsonMatch/);
      assert.match(err.message, /fieldsEqual/);
      return true;
    });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('rowCountMatches respects tolerance', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    const csvPath = path.join(outDir, 'inbound.csv');
    const jsonPath = path.join(outDir, 'outbound.json');
    fs.writeFileSync(csvPath, 'id\n1\n2\n3\n');
    fs.writeFileSync(jsonPath, JSON.stringify([{ recordId: '1' }, { recordId: '2' }]));
    const config: ValidateBusinessLogicConfig = {
      files: [{
        name: 'payload',
        csvPath,
        jsonPath,
        csvKeyField: 'id',
        jsonKeyField: 'recordId',
        rules: [{ type: 'rowCountMatches', tolerance: 1 }],
      }],
    };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.payload_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast on the first invalid entry without checking the rest', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    const badCsvPath = path.join(outDir, 'bad.csv');
    const goodCsvPath = path.join(outDir, 'good.csv');
    const jsonPath = path.join(outDir, 'data.json');
    fs.writeFileSync(badCsvPath, 'id\n1\n2\n'); // 2 rows
    fs.writeFileSync(goodCsvPath, 'id\n1\n'); // 1 row
    fs.writeFileSync(jsonPath, JSON.stringify([{ recordId: '1' }])); // 1 entry
    const config: ValidateBusinessLogicConfig = {
      files: [
        {
          name: 'bad',
          csvPath: badCsvPath,
          jsonPath,
          csvKeyField: 'id',
          jsonKeyField: 'recordId',
          rules: [{ type: 'rowCountMatches' }], // 2 vs 1 -> violation
        },
        {
          name: 'good',
          csvPath: goodCsvPath,
          jsonPath,
          csvKeyField: 'id',
          jsonKeyField: 'recordId',
          rules: [{ type: 'rowCountMatches' }], // 1 vs 1 -> ok
        },
      ],
    };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("bad"\) failed:/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails when the csv file is missing', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    const jsonPath = path.join(outDir, 'data.json');
    fs.writeFileSync(jsonPath, JSON.stringify([{ recordId: '1' }]));
    const config: ValidateBusinessLogicConfig = {
      files: [{
        name: 'missing',
        csvPath: path.join(outDir, 'nope.csv'),
        jsonPath,
        csvKeyField: 'id',
        jsonKeyField: 'recordId',
        rules: [{ type: 'rowCountMatches' }],
      }],
    };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("missing"\) failed:.*not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizlogic-test-'));
  try {
    assert.throws(
      () => runAll({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
