import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './csv';

test('parses a simple csv into headers and row objects', () => {
  const result = parseCsv('id,name\n1,Alice\n2,Bob\n');
  assert.deepEqual(result.headers, ['id', 'name']);
  assert.deepEqual(result.rows, [
    { id: '1', name: 'Alice' },
    { id: '2', name: 'Bob' },
  ]);
});

test('handles a quoted field containing a comma', () => {
  const result = parseCsv('id,name\n1,"Bob, Jr"\n');
  assert.deepEqual(result.rows, [{ id: '1', name: 'Bob, Jr' }]);
});

test('handles a quoted field containing an embedded newline as one row, not two', () => {
  const result = parseCsv('id,note\n1,"line1\nline2"\n2,ok\n');
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], { id: '1', note: 'line1\nline2' });
  assert.deepEqual(result.rows[1], { id: '2', note: 'ok' });
});

test('handles an escaped double-quote inside a quoted field', () => {
  const result = parseCsv('id,quote\n1,"she said ""hi"""\n');
  assert.deepEqual(result.rows, [{ id: '1', quote: 'she said "hi"' }]);
});

test('handles content with no trailing newline', () => {
  const result = parseCsv('id,name\n1,Alice');
  assert.deepEqual(result.rows, [{ id: '1', name: 'Alice' }]);
});

test('returns empty headers and rows for empty content', () => {
  const result = parseCsv('');
  assert.deepEqual(result, { headers: [], rows: [] });
});

test('returns empty rows for a header-only file', () => {
  const result = parseCsv('id,name\n');
  assert.deepEqual(result.headers, ['id', 'name']);
  assert.deepEqual(result.rows, []);
});
