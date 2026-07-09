import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAll } from './validate-json-schema';
import type { StepContext } from '../runner/types';

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

const USER_SCHEMA = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0 },
  },
};

test('validates a conforming JSON file successfully', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    const dataPath = path.join(outDir, 'data.json');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    fs.writeFileSync(dataPath, JSON.stringify({ id: '1', name: 'Alice', age: 30 }));
    const config = { files: [{ name: 'user', filePath: dataPath, schemaPath }] };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.user_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails with every validation error listed when a required field is missing and a type is wrong', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    const dataPath = path.join(outDir, 'data.json');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    fs.writeFileSync(dataPath, JSON.stringify({ name: 'Alice', age: 'thirty' }));
    const config = { files: [{ name: 'user', filePath: dataPath, schemaPath }] };
    assert.throws(() => runAll(config, fakeCtx(outDir)), (err: Error) => {
      assert.match(err.message, /File entry 0 \("user"\) failed:/);
      assert.match(err.message, /required/);
      assert.match(err.message, /age/);
      return true;
    });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast on the first invalid entry without checking the rest', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    const badPath = path.join(outDir, 'bad.json');
    fs.writeFileSync(badPath, JSON.stringify({ age: 5 }));
    const goodPath = path.join(outDir, 'good.json');
    fs.writeFileSync(goodPath, JSON.stringify({ id: '1', name: 'Bob' }));
    const config = {
      files: [
        { name: 'bad', filePath: badPath, schemaPath },
        { name: 'good', filePath: goodPath, schemaPath },
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

test('throws when the data file is missing', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    const config = { files: [{ name: 'missing', filePath: path.join(outDir, 'nope.json'), schemaPath }] };
    assert.throws(
      () => runAll(config, fakeCtx(outDir)),
      /File entry 0 \("missing"\) failed:.*not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    assert.throws(
      () => runAll({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
