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

test('validates a conforming .ndjson file, one JSON value per line', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    const dataPath = path.join(outDir, 'data.ndjson');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    fs.writeFileSync(
      dataPath,
      [
        JSON.stringify({ id: '1', name: 'Alice' }),
        JSON.stringify({ id: '2', name: 'Bob', age: 40 }),
      ].join('\n') + '\n',
    );
    const config = { files: [{ name: 'users', filePath: dataPath, schemaPath }] };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.users_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('ndjson skips blank lines and reports every failing line, not just the first', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    const dataPath = path.join(outDir, 'data.ndjson');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    fs.writeFileSync(
      dataPath,
      [
        JSON.stringify({ id: '1', name: 'Alice' }), // valid
        '',                                          // blank line, must be skipped
        JSON.stringify({ name: 'Bob' }),              // missing id
        JSON.stringify({ id: '3', name: 'Carla', age: 'old' }), // wrong type
      ].join('\n') + '\n',
    );
    const config = { files: [{ name: 'users', filePath: dataPath, schemaPath }] };
    assert.throws(() => runAll(config, fakeCtx(outDir)), (err: Error) => {
      assert.match(err.message, /File entry 0 \("users"\) failed:/);
      assert.match(err.message, /line 3/);
      assert.match(err.message, /line 4/);
      assert.doesNotMatch(err.message, /line 1/);
      assert.doesNotMatch(err.message, /line 2/);
      return true;
    });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('infers ndjson format from .jsonl and .ldjson extensions too', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    const twoLines = [JSON.stringify({ id: '1', name: 'Alice' }), JSON.stringify({ id: '2', name: 'Bob' })].join('\n') + '\n';
    const jsonlPath = path.join(outDir, 'data.jsonl');
    fs.writeFileSync(jsonlPath, twoLines);
    const ldjsonPath = path.join(outDir, 'data.ldjson');
    fs.writeFileSync(ldjsonPath, twoLines);
    const config = {
      files: [
        { name: 'jsonl', filePath: jsonlPath, schemaPath },
        { name: 'ldjson', filePath: ldjsonPath, schemaPath },
      ],
    };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.jsonl_status, 'Succeeded');
    assert.equal(result.outputs?.ldjson_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('an explicit format overrides extension inference', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    // .json extension would normally infer whole-document json, and a file
    // with two top-level JSON values is NOT valid whole-document JSON, so
    // this only passes if format: 'ndjson' actually takes effect.
    const dataPath = path.join(outDir, 'data.json');
    fs.writeFileSync(
      dataPath,
      [JSON.stringify({ id: '1', name: 'Alice' }), JSON.stringify({ id: '2', name: 'Bob' })].join('\n') + '\n',
    );
    const config = { files: [{ name: 'forced', filePath: dataPath, schemaPath, format: 'ndjson' as const }] };
    const result = runAll(config, fakeCtx(outDir));
    assert.equal(result.outputs?.forced_status, 'Succeeded');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('reports malformed JSON syntax with its line number in ndjson', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  try {
    const schemaPath = path.join(outDir, 'schema.json');
    const dataPath = path.join(outDir, 'data.ndjson');
    fs.writeFileSync(schemaPath, JSON.stringify(USER_SCHEMA));
    fs.writeFileSync(dataPath, `${JSON.stringify({ id: '1', name: 'Alice' })}\n{not valid json\n`);
    const config = { files: [{ name: 'broken', filePath: dataPath, schemaPath }] };
    assert.throws(() => runAll(config, fakeCtx(outDir)), (err: Error) => {
      assert.match(err.message, /File entry 0 \("broken"\) failed:/);
      assert.match(err.message, /line 2/);
      return true;
    });
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
