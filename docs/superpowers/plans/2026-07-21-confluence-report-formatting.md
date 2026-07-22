# Confluence Report Rich Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `publish-to-confluence`'s existing `sections` config with per-field formatters (AEST timestamps, ms→s, bytes→KB/MB/GB, status lozenges), array grouping, a Mermaid-gantt layout, freeform static sections, and a table-of-contents flag.

**Architecture:** Everything is additive to `steps/publish-to-confluence.ts` — no new step, no new file, no new dependency. One new pure-function formatter registry (`formatValue`), one new generic grouping helper (`partitionByKey`) reused by both `groupBy` and the gantt layout's `sectionField`, and two new section-rendering branches (`static`, `gantt`) inside the existing `renderSection` dispatcher.

**Tech Stack:** TypeScript (Node's built-in `Intl`/`Date` for AEST conversion — no date library), `node:test` + `node:assert/strict` (matching every existing test in this file).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-21-confluence-report-formatting-design.md` — re-read it if a task's intent is unclear.
- No new npm dependency. No new step file. No changes to `findExistingPage`/`createPage`/`updatePage`/`runAll`'s network flow beyond passing `config.includeToc` through.
- Every existing test in `steps/publish-to-confluence.test.ts` must keep passing unmodified — all new config surface (`format`, `groupBy`, `gantt`, `type`, `includeToc`) is optional and defaults to today's exact behavior when absent.
- Test command for this file only: `npx tsx --test "steps/publish-to-confluence.test.ts"`.
- Full-repo gate before the final commit: `npm test`, `npm run typecheck`, `npm run lint` must all pass.
- Match existing code style exactly: named exports for anything worth unit-testing directly, `resultWithStep(...)` + `renderConfluenceStorageFormat(result, sections)` as the primary test entry point (this file tests behavior through the public render function, not by exporting every internal helper).
- Every new thrown error must be prefixed `section "<title>": ...`, matching every existing error in this file.

---

### Task 1: Config types + formatter plumbing + numeric formatters (`duration-s`, `bytes`, `number`)

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Test: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Produces: `ReportField` (`{ label, field, format?, decimals? }`), extended `ReportSection` (adds `type?`, `groupBy?`, `gantt?`, `html?` — unused until later tasks but declared now so later tasks don't touch this block again), `GanttConfig`, `formatValue(value, format, decimals?)`, `formatBytes(bytes, decimals)`, `renderFieldValue(value, field, sectionTitle)`, `KNOWN_FORMATS: Set<string>` (starts with `'duration-s' | 'bytes' | 'number'` only — Tasks 2 and 3 each add one more entry).
- Consumes: nothing new (builds on existing `escapeXhtml`, `resolveFieldPath`, `isPlainObject`, `renderCell`).

- [ ] **Step 1: Replace the `ReportSection`/config type block**

In `steps/publish-to-confluence.ts`, replace:

```ts
export interface ReportSection {
  title: string;
  /** Step name, matching ConsolidatedStepEntry.stepName in the results JSON. */
  dataFrom: string;
  /** Which part of that step's entry to read. Default 'outputs'. */
  source?: 'outputs' | 'data';
  /** Dot-path within the selected source to the array or object to render. Omit to use the whole source value as-is. */
  arrayPath?: string;
  /** Default 'keyvalue'. */
  layout?: 'table' | 'bullets' | 'keyvalue';
  /** Dot-paths (per item) to extract, with display labels. Omit to use every own-enumerable key. */
  fields?: { label: string; field: string }[];
}

export interface PublishToConfluenceConfig {
  /** e.g. "https://yoursite.atlassian.net/wiki" */
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey: string;
  pageTitle: string;
  /** Optional parent page to create the page under, if it doesn't exist yet. */
  parentPageId?: string;
  /** Path to the JSON artifact produced by consolidate-run-results. */
  resultsPath: string;
  /** Optional custom report layout. Omitted/empty = today's exact behavior. */
  sections?: ReportSection[];
}
```

with:

```ts
export interface ReportField {
  label: string;
  field: string;
  /** Omit to render the raw (escaped) value, exactly as today. */
  format?: 'timestamp-aest' | 'duration-s' | 'bytes' | 'status' | 'number';
  /** Decimal places for 'bytes' | 'number' | 'duration-s'. Default 1 (0 for 'number'). Ignored by 'timestamp-aest' and 'status'. */
  decimals?: number;
}

export interface GanttConfig {
  taskField: string;
  startField: string;
  /** Duration in ms; used only if endField is absent on an item. */
  durationField?: string;
  /** ISO timestamp; takes precedence over durationField if both resolve. */
  endField?: string;
  /** Dot-path; groups bars into separate Mermaid `section` blocks, in order of first appearance. */
  sectionField?: string;
}

export interface ReportSection {
  /** Default 'data'. 'static' ignores every other data-section field below except title/html. */
  type?: 'data' | 'static';
  title: string;
  /** Step name, matching ConsolidatedStepEntry.stepName in the results JSON. Required unless type: 'static'. */
  dataFrom?: string;
  /** Which part of that step's entry to read. Default 'outputs'. */
  source?: 'outputs' | 'data';
  /** Dot-path within the selected source to the array or object to render. Omit to use the whole source value as-is. */
  arrayPath?: string;
  /** Default 'keyvalue'. */
  layout?: 'table' | 'bullets' | 'keyvalue' | 'gantt';
  /** Dot-paths (per item) to extract, with display labels. Omit to use every own-enumerable key. */
  fields?: ReportField[];
  /** Dot-path; splits array data into one <h3> sub-heading + table/bullets per distinct value, in order of first appearance. Only valid with layout 'table' or 'bullets'. */
  groupBy?: string;
  /** Required when layout is 'gantt'. */
  gantt?: GanttConfig;
  /** Required when type is 'static'. Raw Confluence storage-format content, inserted unescaped under <h2>{title}</h2>. */
  html?: string;
}

export interface PublishToConfluenceConfig {
  /** e.g. "https://yoursite.atlassian.net/wiki" */
  baseUrl: string;
  email: string;
  apiToken: string;
  spaceKey: string;
  pageTitle: string;
  /** Optional parent page to create the page under, if it doesn't exist yet. */
  parentPageId?: string;
  /** Path to the JSON artifact produced by consolidate-run-results. */
  resultsPath: string;
  /** Inserts Confluence's native Table of Contents macro as the very first element on the page. Default false. */
  includeToc?: boolean;
  /** Optional custom report layout. Omitted/empty = today's exact behavior. */
  sections?: ReportSection[];
}
```

- [ ] **Step 2: Add the formatter registry, just below `isPlainObject`**

Insert this new block immediately after the existing `isPlainObject` function (before `// ---------- Nested cell rendering ...`):

```ts
// ---------- Field formatters --------------------------------------------------

const KNOWN_FORMATS = new Set<string>(['duration-s', 'bytes', 'number']);

function formatBytes(bytes: number, decimals: number): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatValue(value: unknown, format: string, decimals?: number): string {
  switch (format) {
    case 'duration-s':
      return `${(Number(value) / 1000).toFixed(decimals ?? 1)}s`;
    case 'bytes':
      return formatBytes(Number(value), decimals ?? 1);
    case 'number':
      return Number(value).toFixed(decimals ?? 0);
    default:
      // Unreachable in practice: callers only invoke this after checking
      // KNOWN_FORMATS. Kept as a safe fallback rather than throwing here,
      // since the caller already produces the user-facing error message.
      return escapeXhtml(value);
  }
}
```

- [ ] **Step 3: Add `renderFieldValue` and rewire `fieldEntries`/the three layout renderers to use it**

Replace the existing `fieldEntries` function:

```ts
function fieldEntries(
  item: unknown,
  fields: { label: string; field: string }[] | undefined,
): Array<readonly [string, unknown]> {
  if (fields) return fields.map(f => [f.label, resolveFieldPath(item, f.field)] as const);
  if (isPlainObject(item)) return Object.entries(item);
  return [];
}
```

with:

```ts
interface ResolvedField {
  label: string;
  value: unknown;
  field: ReportField;
}

function fieldEntries(item: unknown, fields: ReportField[] | undefined): ResolvedField[] {
  if (fields) return fields.map(f => ({ label: f.label, value: resolveFieldPath(item, f.field), field: f }));
  if (isPlainObject(item)) return Object.entries(item).map(([label, value]) => ({ label, value, field: { label, field: label } }));
  return [];
}

function renderFieldValue(value: unknown, field: ReportField, sectionTitle: string): string {
  if (Array.isArray(value) || isPlainObject(value)) return renderCell(value);
  if (field.format) {
    if (!KNOWN_FORMATS.has(field.format)) {
      throw new Error(`section "${sectionTitle}": unknown format "${field.format}" for field "${field.field}"`);
    }
    return formatValue(value, field.format, field.decimals);
  }
  return escapeXhtml(value);
}
```

Replace `renderTableSection`:

```ts
function renderTableSection(section: ReportSection, data: unknown): string {
  if (!Array.isArray(data)) {
    throw new Error(`section "${section.title}": table layout requires array data at "${section.arrayPath ?? '(root)'}"`);
  }
  const fields = section.fields
    ?? (data.length > 0 && isPlainObject(data[0]) ? Object.keys(data[0] as object).map(k => ({ label: k, field: k })) : []);
  const headerRow = `<tr>${fields.map(f => `<th>${escapeXhtml(f.label)}</th>`).join('')}</tr>`;
  const bodyRows = data
    .map(item => `<tr>${fields.map(f => `<td>${renderCell(resolveFieldPath(item, f.field))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}
```

with:

```ts
function renderTableSection(section: ReportSection, data: unknown): string {
  if (!Array.isArray(data)) {
    throw new Error(`section "${section.title}": table layout requires array data at "${section.arrayPath ?? '(root)'}"`);
  }
  const fields: ReportField[] = section.fields
    ?? (data.length > 0 && isPlainObject(data[0]) ? Object.keys(data[0] as object).map(k => ({ label: k, field: k })) : []);
  const headerRow = `<tr>${fields.map(f => `<th>${escapeXhtml(f.label)}</th>`).join('')}</tr>`;
  const bodyRows = data
    .map(item => `<tr>${fields.map(f => `<td>${renderFieldValue(resolveFieldPath(item, f.field), f, section.title)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}
```

Replace `renderBulletsSection`:

```ts
function renderBulletsSection(section: ReportSection, data: unknown): string {
  if (Array.isArray(data)) {
    return data
      .map((item, i) => {
        const lines = fieldEntries(item, section.fields)
          .map(([label, v]) => `<li>${escapeXhtml(label)}: ${renderCell(v)}</li>`)
          .join('');
        return `<p><strong>Item ${i + 1}</strong></p><ul>${lines}</ul>`;
      })
      .join('');
  }
  if (isPlainObject(data)) {
    const lines = fieldEntries(data, section.fields)
      .map(([label, v]) => `<li>${escapeXhtml(label)}: ${renderCell(v)}</li>`)
      .join('');
    return `<ul>${lines}</ul>`;
  }
  throw new Error(`section "${section.title}": bullets layout requires array or object data`);
}
```

with:

```ts
function renderBulletsSection(section: ReportSection, data: unknown): string {
  if (Array.isArray(data)) {
    return data
      .map((item, i) => {
        const lines = fieldEntries(item, section.fields)
          .map(({ label, value, field }) => `<li>${escapeXhtml(label)}: ${renderFieldValue(value, field, section.title)}</li>`)
          .join('');
        return `<p><strong>Item ${i + 1}</strong></p><ul>${lines}</ul>`;
      })
      .join('');
  }
  if (isPlainObject(data)) {
    const lines = fieldEntries(data, section.fields)
      .map(({ label, value, field }) => `<li>${escapeXhtml(label)}: ${renderFieldValue(value, field, section.title)}</li>`)
      .join('');
    return `<ul>${lines}</ul>`;
  }
  throw new Error(`section "${section.title}": bullets layout requires array or object data`);
}
```

Replace `renderKeyvalueSection`:

```ts
function renderKeyvalueSection(section: ReportSection, data: unknown): string {
  if (Array.isArray(data)) {
    throw new Error(`section "${section.title}": keyvalue layout requires object data, got an array — did you mean layout: "bullets"?`);
  }
  if (!isPlainObject(data)) {
    throw new Error(`section "${section.title}": keyvalue layout requires object data`);
  }
  const rows = fieldEntries(data, section.fields)
    .map(([label, v]) => `<tr><th>${escapeXhtml(label)}</th><td>${renderCell(v)}</td></tr>`)
    .join('');
  return `<table><tbody>${rows}</tbody></table>`;
}
```

with:

```ts
function renderKeyvalueSection(section: ReportSection, data: unknown): string {
  if (Array.isArray(data)) {
    throw new Error(`section "${section.title}": keyvalue layout requires object data, got an array — did you mean layout: "bullets"?`);
  }
  if (!isPlainObject(data)) {
    throw new Error(`section "${section.title}": keyvalue layout requires object data`);
  }
  const rows = fieldEntries(data, section.fields)
    .map(({ label, value, field }) => `<tr><th>${escapeXhtml(label)}</th><td>${renderFieldValue(value, field, section.title)}</td></tr>`)
    .join('');
  return `<table><tbody>${rows}</tbody></table>`;
}
```

- [ ] **Step 4: Write the failing tests**

Append to `steps/publish-to-confluence.test.ts`:

```ts
test('renderConfluenceStorageFormat formats a field with format:"duration-s"', () => {
  const result = resultWithStep('a', { data: { durationMs: 4200 } });
  const sections = [{
    title: 'D', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Duration', field: 'durationMs', format: 'duration-s' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<th>Duration<\/th><td>4\.2s<\/td>/);
});

test('renderConfluenceStorageFormat "duration-s" respects a custom decimals count', () => {
  const result = resultWithStep('a', { data: { durationMs: 4234 } });
  const sections = [{
    title: 'D', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Duration', field: 'durationMs', format: 'duration-s' as const, decimals: 0 }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>4s<\/td>/);
});

test('renderConfluenceStorageFormat formats a field with format:"bytes", auto-scaling to the largest unit', () => {
  const result = resultWithStep('a', { data: { size: 4404019 } });
  const sections = [{
    title: 'S', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Size', field: 'size', format: 'bytes' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>4\.2 MB<\/td>/);
});

test('renderConfluenceStorageFormat "bytes" keeps small values in bytes', () => {
  const result = resultWithStep('a', { data: { size: 512 } });
  const sections = [{
    title: 'S', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Size', field: 'size', format: 'bytes' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>512\.0 B<\/td>/);
});

test('renderConfluenceStorageFormat formats a field with format:"number" and decimals', () => {
  const result = resultWithStep('a', { data: { ratio: 0.98765 } });
  const sections = [{
    title: 'N', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Ratio', field: 'ratio', format: 'number' as const, decimals: 2 }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>0\.99<\/td>/);
});

test('renderConfluenceStorageFormat throws for an unrecognized format value', () => {
  const result = resultWithStep('a', { data: { x: 1 } });
  const sections = [{
    title: 'X', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'X', field: 'x', format: 'not-a-format' as any }],
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /unknown format "not-a-format" for field "x"/);
});

test('renderConfluenceStorageFormat leaves unformatted fields exactly as before', () => {
  const result = resultWithStep('a', { data: { name: 'plain' } });
  const sections = [{
    title: 'P', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Name', field: 'name' }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>plain<\/td>/);
});
```

- [ ] **Step 5: Run the tests to verify they fail, then pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected first: FAIL (format/decimals not yet applied — `formatValue`/`renderFieldValue` didn't exist before Step 2/3, or the field isn't wired in).
After Steps 1–3 are in place: expected PASS for all tests (existing + new), 0 failures.

- [ ] **Step 6: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
feat(publish-to-confluence): add field format config and numeric formatters

Adds ReportField.format/decimals plus a formatValue registry covering
duration-s, bytes, and number. No format = today's exact rendering.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `timestamp-aest` formatter

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Test: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: `KNOWN_FORMATS` (Task 1, add `'timestamp-aest'`), `formatValue`'s switch (Task 1, add a case).
- Produces: `formatTimestampAest(value: unknown): string`.

- [ ] **Step 1: Add `'timestamp-aest'` to `KNOWN_FORMATS` and the `formatValue` switch**

Change:

```ts
const KNOWN_FORMATS = new Set<string>(['duration-s', 'bytes', 'number']);
```

to:

```ts
const KNOWN_FORMATS = new Set<string>(['duration-s', 'bytes', 'number', 'timestamp-aest']);
```

In `formatValue`, add a case above `default`:

```ts
    case 'timestamp-aest':
      return formatTimestampAest(value);
```

- [ ] **Step 2: Add `formatTimestampAest`, just below `formatBytes`**

```ts
function formatTimestampAest(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${get('timeZoneName')}`;
}
```

`Intl` resolves `timeZoneName: 'short'` for `Australia/Sydney` to the literal abbreviation `AEST` or `AEDT` (verified directly — not `GMT+10`), so no manual offset table is needed for the DST switch.

- [ ] **Step 3: Write the failing tests**

Append:

```ts
test('renderConfluenceStorageFormat formats format:"timestamp-aest" in AEST (winter, UTC+10)', () => {
  const result = resultWithStep('a', { data: { runStart: '2026-07-21T04:32:05.000Z' } });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Start', field: 'runStart', format: 'timestamp-aest' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>2026-07-21 14:32:05 AEST<\/td>/);
});

test('renderConfluenceStorageFormat formats format:"timestamp-aest" in AEDT (summer, UTC+11)', () => {
  const result = resultWithStep('a', { data: { runStart: '2026-01-15T04:32:05.000Z' } });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Start', field: 'runStart', format: 'timestamp-aest' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>2026-01-15 15:32:05 AEDT<\/td>/);
});

test('renderConfluenceStorageFormat "timestamp-aest" crosses the DST boundary correctly', () => {
  const result = resultWithStep('a', {
    data: { before: '2026-04-04T15:59:00.000Z', after: '2026-04-04T16:01:00.000Z' },
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [
      { label: 'Before', field: 'before', format: 'timestamp-aest' as const },
      { label: 'After', field: 'after', format: 'timestamp-aest' as const },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>2026-04-04 02:59:00 AEDT<\/td>/);
  assert.match(html, /<td>2026-04-04 02:01:00 AEST<\/td>/);
});
```

- [ ] **Step 4: Run the tests to verify they fail, then pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected first: FAIL (`'timestamp-aest'` not yet in `KNOWN_FORMATS`, so it hits the "unknown format" error instead of rendering a timestamp).
After Steps 1–2: expected PASS.

- [ ] **Step 5: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
feat(publish-to-confluence): add timestamp-aest field formatter

Converts UTC ISO timestamps to Australia/Sydney local time via Intl,
correctly labeling AEST vs AEDT across the DST boundary.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `status` formatter (Confluence status lozenge)

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Test: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: `KNOWN_FORMATS`, `formatValue`'s switch (both from Task 1/2).
- Produces: `formatStatusLozenge(value: unknown): string`.

- [ ] **Step 1: Add `'status'` to `KNOWN_FORMATS` and the `formatValue` switch**

Change:

```ts
const KNOWN_FORMATS = new Set<string>(['duration-s', 'bytes', 'number', 'timestamp-aest']);
```

to:

```ts
const KNOWN_FORMATS = new Set<string>(['duration-s', 'bytes', 'number', 'timestamp-aest', 'status']);
```

In `formatValue`, add a case above `default`:

```ts
    case 'status':
      return formatStatusLozenge(value);
```

- [ ] **Step 2: Add `formatStatusLozenge`, just below `formatTimestampAest`**

```ts
const STATUS_LOZENGE_COLORS: Record<string, string> = {
  Succeeded: 'Green',
  Failed: 'Red',
  InProgress: 'Blue',
  Queued: 'Blue',
};

function formatStatusLozenge(value: unknown): string {
  const text = value == null ? '' : String(value);
  const colour = STATUS_LOZENGE_COLORS[text] ?? 'Grey';
  return `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${colour}</ac:parameter><ac:parameter ac:name="title">${escapeXhtml(text)}</ac:parameter></ac:structured-macro>`;
}
```

Note this is the one formatter whose *value* isn't `escapeXhtml`'d as plain text — it returns XML macro markup. The raw value is still escaped when used as the macro's `title` parameter (matters for a status string that happens to contain `<`/`&`).

- [ ] **Step 3: Write the failing tests**

Append:

```ts
test('renderConfluenceStorageFormat formats format:"status" as a colored status lozenge macro', () => {
  const result = resultWithStep('a', { data: { status: 'Succeeded' } });
  const sections = [{
    title: 'St', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [{ label: 'Status', field: 'status', format: 'status' as const }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(
    html,
    /<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green<\/ac:parameter><ac:parameter ac:name="title">Succeeded<\/ac:parameter><\/ac:structured-macro>/,
  );
});

test('renderConfluenceStorageFormat "status" maps Failed to Red and escapes an unrecognized value mapped to Grey', () => {
  const result = resultWithStep('a', { data: { a: 'Failed', b: 'Weird<Value>' } });
  const sections = [{
    title: 'St', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const,
    fields: [
      { label: 'A', field: 'a', format: 'status' as const },
      { label: 'B', field: 'b', format: 'status' as const },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /colour">Red<\/ac:parameter><ac:parameter ac:name="title">Failed/);
  assert.match(html, /colour">Grey<\/ac:parameter><ac:parameter ac:name="title">Weird&lt;Value&gt;/);
});
```

- [ ] **Step 4: Run the tests to verify they fail, then pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected first: FAIL (`'status'` not yet in `KNOWN_FORMATS`).
After Steps 1–2: expected PASS.

- [ ] **Step 5: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
feat(publish-to-confluence): add status field formatter (lozenge macro)

Renders status-like fields as Confluence's native colored status
macro instead of plain text.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `groupBy` (sub-heading per group, table + bullets)

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Test: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Produces: `partitionByKey<T>(items: T[], keyFn: (item: T) => string): Array<{ key: string; items: T[] }>` — a generic helper Task 5 also reuses for the gantt layout's `sectionField`.
- Consumes: `renderTableSection`, `renderBulletsSection` (Task 1, unchanged signatures — called per-group with a subset array), `resolveFieldPath` (existing), `renderSection` (existing dispatcher, modified here).

- [ ] **Step 1: Add `partitionByKey`, just above `renderSection`**

```ts
function partitionByKey<T>(items: T[], keyFn: (item: T) => string): Array<{ key: string; items: T[] }> {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(item);
  }
  return order.map(key => ({ key, items: map.get(key)! }));
}
```

- [ ] **Step 2: Wire `groupBy` into `renderSection`**

Find the tail of `renderSection`:

```ts
  const layout = section.layout ?? 'keyvalue';
  const body = layout === 'table' ? renderTableSection(section, data)
    : layout === 'bullets' ? renderBulletsSection(section, data)
    : renderKeyvalueSection(section, data);

  return `<h2>${escapeXhtml(section.title)}</h2>${body}`;
}
```

Replace it with:

```ts
  const layout = section.layout ?? 'keyvalue';

  if (section.groupBy) {
    if (layout !== 'table' && layout !== 'bullets') {
      throw new Error(`section "${section.title}": groupBy is not supported on layout "${layout}"`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`section "${section.title}": groupBy requires array data`);
    }
    const groupBy = section.groupBy;
    const groups = partitionByKey(data, item => String(resolveFieldPath(item, groupBy) ?? ''));
    const body = groups
      .map(({ key, items }) => {
        const groupBody = layout === 'table' ? renderTableSection(section, items) : renderBulletsSection(section, items);
        return `<h3>${escapeXhtml(key)}</h3>${groupBody}`;
      })
      .join('');
    return `<h2>${escapeXhtml(section.title)}</h2>${body}`;
  }

  const body = layout === 'table' ? renderTableSection(section, data)
    : layout === 'bullets' ? renderBulletsSection(section, data)
    : renderKeyvalueSection(section, data);

  return `<h2>${escapeXhtml(section.title)}</h2>${body}`;
}
```

- [ ] **Step 3: Write the failing tests**

Append:

```ts
test('renderConfluenceStorageFormat groupBy splits a table section into one sub-heading and table per group, in order of first appearance', () => {
  const result = resultWithStep('a', {
    data: [
      { parentRunId: 'p1', pipelineName: 'ChildA' },
      { parentRunId: 'p1', pipelineName: 'ChildB' },
      { parentRunId: 'p2', pipelineName: 'ChildC' },
    ],
  });
  const sections = [{
    title: 'Runs', dataFrom: 'a', source: 'data' as const, layout: 'table' as const, groupBy: 'parentRunId',
    fields: [{ label: 'Pipeline', field: 'pipelineName' }],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h2>Runs<\/h2>/);
  assert.match(html, /<h3>p1<\/h3>/);
  assert.match(html, /<h3>p2<\/h3>/);
  assert.match(html, /<td>ChildA<\/td>/);
  assert.match(html, /<td>ChildC<\/td>/);
  const p1Index = html.indexOf('<h3>p1</h3>');
  const p2Index = html.indexOf('<h3>p2</h3>');
  const childCIndex = html.indexOf('<td>ChildC</td>');
  assert.ok(p1Index < p2Index);
  assert.ok(p2Index < childCIndex);
});

test('renderConfluenceStorageFormat groupBy also works with layout:"bullets"', () => {
  const result = resultWithStep('a', {
    data: [
      { parentRunId: 'p1', pipelineName: 'ChildA' },
      { parentRunId: 'p2', pipelineName: 'ChildC' },
    ],
  });
  const sections = [{
    title: 'Runs', dataFrom: 'a', source: 'data' as const, layout: 'bullets' as const, groupBy: 'parentRunId',
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h3>p1<\/h3>/);
  assert.match(html, /<h3>p2<\/h3>/);
  assert.match(html, /<li>pipelineName: ChildA<\/li>/);
});

test('renderConfluenceStorageFormat throws when groupBy is combined with layout:"gantt"', () => {
  const result = resultWithStep('a', { data: [{ x: 1 }] });
  const sections = [{
    title: 'G', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const, groupBy: 'x',
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /groupBy is not supported on layout "gantt"/);
});

test('renderConfluenceStorageFormat throws when groupBy is used on non-array data', () => {
  const result = resultWithStep('a', { data: { notAnArray: true } });
  const sections = [{ title: 'G', dataFrom: 'a', source: 'data' as const, layout: 'table' as const, groupBy: 'x' }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /groupBy requires array data/);
});
```

- [ ] **Step 4: Run the tests to verify they fail, then pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected first: FAIL (`groupBy` doesn't exist on `ReportSection` behavior yet — `renderSection` ignores it).
After Steps 1–2: expected PASS.

- [ ] **Step 5: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
feat(publish-to-confluence): add groupBy sub-heading splitting

Splits table/bullets array sections into one <h3> + table per distinct
groupBy value, e.g. ADF pipeline runs grouped by parent run.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `gantt` layout (Mermaid gantt in a code-block macro)

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Test: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: `partitionByKey` (Task 4), `resolveFieldPath` (existing), `GanttConfig` (Task 1).
- Produces: `renderGanttSection(section: ReportSection, data: unknown): string`, wired into `renderSection`'s layout dispatch.

- [ ] **Step 1: Add `renderGanttSection`, just above `renderSection`**

```ts
function sanitizeMermaidText(value: unknown): string {
  return String(value ?? '').replace(/:/g, '');
}

function resolveGanttEnd(item: unknown, gantt: GanttConfig, index: number, sectionTitle: string): string {
  const endRaw = gantt.endField ? resolveFieldPath(item, gantt.endField) : undefined;
  if (endRaw != null) return new Date(String(endRaw)).toISOString();
  const startRaw = resolveFieldPath(item, gantt.startField);
  const durationRaw = gantt.durationField ? resolveFieldPath(item, gantt.durationField) : undefined;
  if (startRaw != null && durationRaw != null) {
    return new Date(new Date(String(startRaw)).getTime() + Number(durationRaw)).toISOString();
  }
  throw new Error(`section "${sectionTitle}": item ${index + 1} has no resolvable end time (need endField or durationField)`);
}

function renderGanttSection(section: ReportSection, data: unknown): string {
  const gantt = section.gantt;
  if (!gantt || !gantt.taskField || !gantt.startField) {
    throw new Error(`section "${section.title}": gantt layout requires gantt.taskField and gantt.startField`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`section "${section.title}": gantt layout requires array data`);
  }

  const bars = data.map((item, index) => {
    const sectionKey = gantt.sectionField ? String(resolveFieldPath(item, gantt.sectionField) ?? '') : 'Activities';
    const taskName = sanitizeMermaidText(resolveFieldPath(item, gantt.taskField));
    const start = new Date(String(resolveFieldPath(item, gantt.startField))).toISOString();
    const end = resolveGanttEnd(item, gantt, index, section.title);
    return { sectionKey, line: `    ${taskName} : ${start}, ${end}` };
  });

  const groups = partitionByKey(bars, bar => bar.sectionKey);
  const body = groups.flatMap(g => [`    section ${sanitizeMermaidText(g.key)}`, ...g.items.map(b => b.line)]);

  const mermaid = [
    'gantt',
    '    dateFormat  YYYY-MM-DDTHH:mm:ss.SSS',
    '    axisFormat  %H:%M:%S',
    `    title ${sanitizeMermaidText(section.title)}`,
    ...body,
  ].join('\n');

  return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter><ac:plain-text-body><![CDATA[\n${mermaid}\n]]></ac:plain-text-body></ac:structured-macro>`;
}
```

- [ ] **Step 2: Wire `'gantt'` into `renderSection`'s layout dispatch**

Change:

```ts
  const body = layout === 'table' ? renderTableSection(section, data)
    : layout === 'bullets' ? renderBulletsSection(section, data)
    : renderKeyvalueSection(section, data);
```

(this is the second occurrence, inside the non-`groupBy` branch added in Task 4) to:

```ts
  const body = layout === 'table' ? renderTableSection(section, data)
    : layout === 'bullets' ? renderBulletsSection(section, data)
    : layout === 'gantt' ? renderGanttSection(section, data)
    : renderKeyvalueSection(section, data);
```

- [ ] **Step 3: Write the failing tests**

Append:

```ts
test('renderConfluenceStorageFormat renders a gantt layout as a Mermaid code-block macro using durationField', () => {
  const result = resultWithStep('a', {
    data: [{ activityName: 'CopyData', activityRunStart: '2026-07-21T09:00:00.000Z', durationMs: 30000 }],
  });
  const sections = [{
    title: 'Timeline', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'activityName', startField: 'activityRunStart', durationField: 'durationMs' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid<\/ac:parameter>/);
  assert.match(html, /gantt/);
  assert.match(html, /section Activities/);
  assert.match(html, /CopyData : 2026-07-21T09:00:00\.000Z, 2026-07-21T09:00:30\.000Z/);
});

test('renderConfluenceStorageFormat gantt prefers endField over durationField when both resolve', () => {
  const result = resultWithStep('a', {
    data: [{ name: 'A', s: '2026-07-21T09:00:00.000Z', e: '2026-07-21T09:05:00.000Z', durationMs: 999 }],
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's', endField: 'e', durationField: 'durationMs' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /A : 2026-07-21T09:00:00\.000Z, 2026-07-21T09:05:00\.000Z/);
});

test('renderConfluenceStorageFormat gantt groups bars into Mermaid sections via sectionField, in order of first appearance', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'A1', s: '2026-07-21T09:00:00.000Z', durationMs: 1000, pipelineRunId: 'run-1' },
      { name: 'B1', s: '2026-07-21T09:00:01.000Z', durationMs: 1000, pipelineRunId: 'run-2' },
      { name: 'A2', s: '2026-07-21T09:00:02.000Z', durationMs: 1000, pipelineRunId: 'run-1' },
    ],
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs', sectionField: 'pipelineRunId' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  const run1Index = html.indexOf('section run-1');
  const run2Index = html.indexOf('section run-2');
  const a1Index = html.indexOf('A1 :');
  const a2Index = html.indexOf('A2 :');
  const b1Index = html.indexOf('B1 :');
  assert.ok(run1Index < a1Index);
  assert.ok(a1Index < a2Index);
  assert.ok(a2Index < run2Index);
  assert.ok(run2Index < b1Index);
});

test('renderConfluenceStorageFormat gantt strips colons from task names (Mermaid field separator)', () => {
  const result = resultWithStep('a', {
    data: [{ name: 'Copy: Orders', s: '2026-07-21T09:00:00.000Z', durationMs: 1000 }],
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /Copy Orders : /);
  assert.doesNotMatch(html, /Copy: Orders/);
});

test('renderConfluenceStorageFormat throws when gantt layout is missing gantt.taskField/startField', () => {
  const result = resultWithStep('a', { data: [{ x: 1 }] });
  const sections = [{ title: 'G', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /gantt layout requires gantt\.taskField and gantt\.startField/);
});

test('renderConfluenceStorageFormat throws when a gantt item has no resolvable end time', () => {
  const result = resultWithStep('a', { data: [{ name: 'A', s: '2026-07-21T09:00:00.000Z' }] });
  const sections = [{
    title: 'G', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's' },
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /item 1 has no resolvable end time/);
});
```

- [ ] **Step 4: Run the tests to verify they fail, then pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected first: FAIL (`layout: 'gantt'` falls through to `renderKeyvalueSection` before Step 2, which throws a keyvalue-shaped error instead).
After Steps 1–2: expected PASS.

- [ ] **Step 5: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
feat(publish-to-confluence): add gantt layout (Mermaid code-block macro)

Renders array data as a Mermaid gantt chart wrapped in a Confluence
code-block macro, with optional sectionField grouping of bars.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Static sections (`type: 'static'`)

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Test: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: `ReportSection.type`/`.html` (Task 1), `escapeXhtml` (existing).
- Produces: nothing new exported — a branch at the top of `renderSection`.

- [ ] **Step 1: Add the static-section branch at the top of `renderSection`**

Find the start of `renderSection`:

```ts
function renderSection(section: ReportSection, result: ConsolidatedResult): string {
  const stepEntry = result.steps.find(s => s.stepName === section.dataFrom);
```

Replace with:

```ts
function renderSection(section: ReportSection, result: ConsolidatedResult): string {
  if (section.type === 'static') {
    if (!section.html) {
      throw new Error(`section "${section.title}": type "static" requires html`);
    }
    return `<h2>${escapeXhtml(section.title)}</h2>${section.html}`;
  }

  const stepEntry = result.steps.find(s => s.stepName === section.dataFrom);
```

- [ ] **Step 2: Write the failing tests**

Append:

```ts
test('renderConfluenceStorageFormat renders a type:"static" section with raw, unescaped html', () => {
  const result = resultWithStep('a', {});
  const sections = [{ type: 'static' as const, title: 'Release Notes', html: '<p>Deployed by CI.</p>' }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h2>Release Notes<\/h2><p>Deployed by CI\.<\/p>/);
});

test('renderConfluenceStorageFormat throws when a type:"static" section has no html', () => {
  const result = resultWithStep('a', {});
  const sections = [{ type: 'static' as const, title: 'Notes' }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /type "static" requires html/);
});
```

- [ ] **Step 3: Run the tests to verify they fail, then pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected first: FAIL (`type: 'static'` falls through to the `dataFrom`-lookup path, throwing `no step named "undefined"`).
After Step 1: expected PASS.

- [ ] **Step 4: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
feat(publish-to-confluence): add type:"static" sections

Lets a section render arbitrary authored content instead of step
data, for release notes or other custom prose.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `includeToc`

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Test: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: `PublishToConfluenceConfig.includeToc` (Task 1).
- Produces: `renderConfluenceStorageFormat(result, sections?, includeToc?)` — new optional third parameter (backward compatible; every existing call site with 1–2 args keeps working).

- [ ] **Step 1: Add the `includeToc` parameter and TOC macro to `renderConfluenceStorageFormat`**

Find:

```ts
export function renderConfluenceStorageFormat(result: ConsolidatedResult, sections?: ReportSection[]): string {
  const metadataRows = Object.entries(result.runMetadata)
    .map(([k, v]) => `<tr><th>${escapeXhtml(k)}</th><td>${escapeXhtml(v)}</td></tr>`)
    .join('');

  const summaryTable = `<h2>Run Summary</h2>
<table><tbody>
${metadataRows}
<tr><th>Generated At</th><td>${escapeXhtml(result.generatedAt)}</td></tr>
<tr><th>Total Steps</th><td>${result.summary.totalSteps}</td></tr>
<tr><th>Succeeded</th><td>${result.summary.succeededCount}</td></tr>
<tr><th>Failed</th><td>${result.summary.failedCount}</td></tr>
</tbody></table>`;

  if (sections && sections.length > 0) {
    const customSections = sections.map(section => renderSection(section, result)).join('\n');
    return `${summaryTable}\n${customSections}`;
  }

  const stepRows = result.steps
    .map(step => {
      const outputsList = Object.entries(step.outputs)
        .map(([k, v]) => `${escapeXhtml(k)}: ${escapeXhtml(v)}`)
        .join('<br/>');
      const status = step.ok ? 'Succeeded' : 'Failed';
      const errorCell = step.error ? `<br/><strong>Error:</strong> ${escapeXhtml(step.error)}` : '';
      return `<tr><td>${escapeXhtml(step.stepName)}</td><td>${status}${errorCell}</td><td>${outputsList}</td></tr>`;
    })
    .join('');

  return `${summaryTable}
<h2>Step Results</h2>
<table><thead><tr><th>Step</th><th>Status</th><th>Outputs</th></tr></thead><tbody>
${stepRows}
</tbody></table>`;
}
```

Replace with:

```ts
export function renderConfluenceStorageFormat(result: ConsolidatedResult, sections?: ReportSection[], includeToc?: boolean): string {
  const toc = includeToc ? '<ac:structured-macro ac:name="toc" />' : '';
  const metadataRows = Object.entries(result.runMetadata)
    .map(([k, v]) => `<tr><th>${escapeXhtml(k)}</th><td>${escapeXhtml(v)}</td></tr>`)
    .join('');

  const summaryTable = `<h2>Run Summary</h2>
<table><tbody>
${metadataRows}
<tr><th>Generated At</th><td>${escapeXhtml(result.generatedAt)}</td></tr>
<tr><th>Total Steps</th><td>${result.summary.totalSteps}</td></tr>
<tr><th>Succeeded</th><td>${result.summary.succeededCount}</td></tr>
<tr><th>Failed</th><td>${result.summary.failedCount}</td></tr>
</tbody></table>`;

  if (sections && sections.length > 0) {
    const customSections = sections.map(section => renderSection(section, result)).join('\n');
    return `${toc}${summaryTable}\n${customSections}`;
  }

  const stepRows = result.steps
    .map(step => {
      const outputsList = Object.entries(step.outputs)
        .map(([k, v]) => `${escapeXhtml(k)}: ${escapeXhtml(v)}`)
        .join('<br/>');
      const status = step.ok ? 'Succeeded' : 'Failed';
      const errorCell = step.error ? `<br/><strong>Error:</strong> ${escapeXhtml(step.error)}` : '';
      return `<tr><td>${escapeXhtml(step.stepName)}</td><td>${status}${errorCell}</td><td>${outputsList}</td></tr>`;
    })
    .join('');

  return `${toc}${summaryTable}
<h2>Step Results</h2>
<table><thead><tr><th>Step</th><th>Status</th><th>Outputs</th></tr></thead><tbody>
${stepRows}
</tbody></table>`;
}
```

- [ ] **Step 2: Pass `config.includeToc` through in `runAll`**

Find, in `runAll`:

```ts
  const content = renderConfluenceStorageFormat(result, config.sections);
```

Replace with:

```ts
  const content = renderConfluenceStorageFormat(result, config.sections, config.includeToc);
```

- [ ] **Step 3: Write the failing tests**

Append:

```ts
test('renderConfluenceStorageFormat includes the Confluence TOC macro as the first element when includeToc is true', () => {
  const result = resultWithStep('a', { outputs: {} });
  const html = renderConfluenceStorageFormat(result, undefined, true);
  assert.ok(html.startsWith('<ac:structured-macro ac:name="toc" />'));
});

test('renderConfluenceStorageFormat omits the TOC macro when includeToc is false or omitted', () => {
  const result = resultWithStep('a', { outputs: {} });
  const html = renderConfluenceStorageFormat(result);
  assert.doesNotMatch(html, /ac:name="toc"/);
});
```

- [ ] **Step 4: Run the tests to verify they fail, then pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected first: FAIL (`includeToc` parameter doesn't exist yet, so the macro never appears).
After Step 1: expected PASS.

- [ ] **Step 5: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
feat(publish-to-confluence): add includeToc config flag

Inserts Confluence's native Table of Contents macro at the top of
the page when includeToc is true.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Integration test, example config, full verification gate

**Files:**
- Modify: `configs/publish-to-confluence.json`
- Test: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: nothing new — this task proves the whole feature set works together end to end and updates the shipped example config to demonstrate it.

- [ ] **Step 1: Write one full-page integration test combining every new feature**

Append to `steps/publish-to-confluence.test.ts`:

```ts
test('runAll renders a full page combining format, groupBy, gantt, static sections, and includeToc', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-test-'));
  try {
    const filePath = path.join(outDir, 'run-results.json');
    fs.writeFileSync(filePath, JSON.stringify({
      runMetadata: { buildId: '1' },
      generatedAt: 't',
      steps: [{
        stepName: 'extractAdfDetails',
        ok: true,
        outputs: {},
        data: {
          pipelineRuns: [
            { pipelineName: 'ChildA', parentRunId: 'p1', status: 'Succeeded', runStart: '2026-07-21T04:00:00.000Z', durationMs: 4200 },
            { pipelineName: 'ChildB', parentRunId: 'p2', status: 'Failed', runStart: '2026-07-21T04:05:00.000Z', durationMs: 1000 },
          ],
          activities: [
            { activityName: 'CopyData', activityRunStart: '2026-07-21T04:00:00.000Z', durationMs: 30000, pipelineRunId: 'p1' },
          ],
        },
      }],
      summary: { totalSteps: 1, succeededCount: 1, failedCount: 0 },
    }));
    const fetchImpl: FetchLike = async url => {
      if (url.includes('spaceKey=')) return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({ id: 'new-1', _links: { webui: '/x' } }), text: async () => '' };
    };
    const config = {
      baseUrl: 'https://example.atlassian.net/wiki', email: 'e', apiToken: 't',
      spaceKey: 'ENG', pageTitle: 'Status', resultsPath: filePath,
      includeToc: true,
      sections: [
        { type: 'static' as const, title: 'Overview', html: '<p>Nightly ADF run.</p>' },
        {
          title: 'ADF Pipeline Runs', dataFrom: 'extractAdfDetails', source: 'data' as const,
          arrayPath: 'pipelineRuns', layout: 'table' as const, groupBy: 'parentRunId',
          fields: [
            { label: 'Pipeline', field: 'pipelineName' },
            { label: 'Status', field: 'status', format: 'status' as const },
            { label: 'Start', field: 'runStart', format: 'timestamp-aest' as const },
            { label: 'Duration', field: 'durationMs', format: 'duration-s' as const },
          ],
        },
        {
          title: 'ADF Activity Timeline', dataFrom: 'extractAdfDetails', source: 'data' as const,
          arrayPath: 'activities', layout: 'gantt' as const,
          gantt: { taskField: 'activityName', startField: 'activityRunStart', durationField: 'durationMs', sectionField: 'pipelineRunId' },
        },
      ],
    };
    await runAll(config, fakeCtx(outDir), fetchImpl);
    const content = fs.readFileSync(path.join(outDir, 'confluence-page-content.html'), 'utf8');
    assert.ok(content.startsWith('<ac:structured-macro ac:name="toc" />'));
    assert.match(content, /<h2>Overview<\/h2><p>Nightly ADF run\.<\/p>/);
    assert.match(content, /<h3>p1<\/h3>/);
    assert.match(content, /<h3>p2<\/h3>/);
    assert.match(content, /colour">Green/);
    assert.match(content, /colour">Red/);
    assert.match(content, /2026-07-21 14:00:00 AEST/);
    assert.match(content, /4\.2s/);
    assert.match(content, /language">mermaid/);
    assert.match(content, /CopyData : 2026-07-21T04:00:00\.000Z, 2026-07-21T04:00:30\.000Z/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected: PASS (all prior tests from Tasks 1–7 plus this one — since every feature it exercises already landed in earlier tasks, this should pass immediately; it's an integration check, not new behavior).

- [ ] **Step 3: Update the example config to showcase the new features**

Replace the contents of `configs/publish-to-confluence.json`:

```json
{
  "baseUrl": "https://yoursite.atlassian.net/wiki",
  "email": "{{env.CONFLUENCE_EMAIL}}",
  "apiToken": "{{env.CONFLUENCE_API_TOKEN}}",
  "spaceKey": "ENG",
  "pageTitle": "Pipeline Run Status",
  "resultsPath": "{{env.PIPELINE_WORKSPACE}}/step-output-final/consolidateResults/run-results.json",
  "includeToc": true,
  "sections": [
    {
      "title": "ADF Pipeline Runs",
      "dataFrom": "extractAdfDetails",
      "source": "data",
      "arrayPath": "pipelineRuns",
      "layout": "table",
      "groupBy": "parentRunId",
      "fields": [
        { "label": "Pipeline", "field": "pipelineName" },
        { "label": "Run ID", "field": "runId" },
        { "label": "Status", "field": "status", "format": "status" },
        { "label": "Start (AEST)", "field": "runStart", "format": "timestamp-aest" },
        { "label": "Duration", "field": "durationMs", "format": "duration-s" }
      ]
    },
    {
      "title": "ADF Activities",
      "dataFrom": "extractAdfDetails",
      "source": "data",
      "arrayPath": "activities",
      "layout": "table",
      "groupBy": "pipelineRunId",
      "fields": [
        { "label": "Activity", "field": "activityName" },
        { "label": "Activity ID", "field": "activityId" },
        { "label": "Status", "field": "status", "format": "status" },
        { "label": "Start (AEST)", "field": "activityRunStart", "format": "timestamp-aest" },
        { "label": "Duration", "field": "durationMs", "format": "duration-s" }
      ]
    },
    {
      "title": "ADF Activity Timeline",
      "dataFrom": "extractAdfDetails",
      "source": "data",
      "arrayPath": "activities",
      "layout": "gantt",
      "gantt": {
        "taskField": "activityName",
        "startField": "activityRunStart",
        "durationField": "durationMs",
        "sectionField": "pipelineRunId"
      }
    },
    {
      "title": "Business Logic Validation",
      "dataFrom": "validateBusinessLogic",
      "layout": "bullets"
    }
  ]
}
```

- [ ] **Step 4: Run the full verification gate**

Run, in order:

```bash
npm test
npm run typecheck
npm run lint
```

Expected: all three exit 0. `npm test` runs every `steps/**/*.test.ts` file (not just this one) — confirms nothing in the rest of the repo broke.

- [ ] **Step 5: Commit**

```bash
git add steps/publish-to-confluence.test.ts configs/publish-to-confluence.json
git commit -m "$(cat <<'EOF'
test(publish-to-confluence): add full-page integration test; update example config

Combines formatters, groupBy, gantt, static sections, and includeToc
in one end-to-end test, and updates the shipped example config to
demonstrate the new sections config surface.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** every numbered item in the design spec has a task — formatters (Tasks 1–3), `groupBy` (Task 4), `gantt` (Task 5), static sections (Task 6), `includeToc` (Task 7), and the combined proof + shipped example (Task 8).
- **Type consistency:** `ReportField`, `GanttConfig`, and the extended `ReportSection` are defined once in Task 1 and never redefined — every later task only adds behavior for fields that already exist on the type. `renderFieldValue(value, field, sectionTitle)`'s signature is introduced in Task 1 and used unchanged in Tasks 2–7 (they only add `formatValue` switch cases and `KNOWN_FORMATS` entries, never touch the renderer signatures). `partitionByKey<T>` is defined once in Task 4 and reused as-is (with a different `T`) in Task 5.
- **No placeholders:** every step shows the exact code to add/replace and the exact test code; no task defers content to "later" or another task's description.
