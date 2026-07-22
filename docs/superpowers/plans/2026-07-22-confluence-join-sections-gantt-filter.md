# Confluence Join Sections + Gantt Duration Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `type: 'join'` section that combines multiple named steps' array data into one table (outer-join by an optional `keyField`, or plain union when sources share no key), and a `gantt.minDurationS` filter that drops short activities from overcrowded gantt charts.

**Architecture:** All changes are to one existing file, `steps/publish-to-confluence.ts` (and its test file) — no new files, no changes to any step or config outside this one. Task 1 extracts a shared helper with zero behavior change (needed by Task 2). Task 2 and Task 3 are independent of each other but both build on Task 1.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-confluence-join-sections-gantt-filter-design.md` — re-read it if a task's intent is unclear.
- No new npm dependency. No new files.
- Every existing test in `steps/publish-to-confluence.test.ts` must keep passing unmodified — all new config surface (`type: 'join'`, `join`, `gantt.minDurationS`) is optional and inert when absent.
- Test command for the step file: `npx tsx --test "steps/publish-to-confluence.test.ts"`.
- Full-repo gate before Task 3's final commit: `npm test`, `npm run typecheck`, `npm run lint` must all pass.
- Every new thrown error is prefixed `section "<title>": ...`, matching every existing error in this file.
- Task ordering: Task 1 must land before Task 2 (Task 2 uses `resolveSectionData`). Task 3 is independent of Task 2 but is sequenced last here for a single-threaded review flow; nothing in Task 3 depends on Task 2's code.

---

### Task 1: Extract `resolveSectionData` (pure refactor, zero behavior change)

**Files:**
- Modify: `steps/publish-to-confluence.ts`

**Interfaces:**
- Produces: `resolveSectionData(dataFrom: string | undefined, source: 'outputs' | 'data' | undefined, arrayPath: string | undefined, result: ConsolidatedResult, sectionTitle: string): unknown` — used by `renderSection`'s main body (this task) and by `renderJoinSection` (Task 2).
- Consumes: `resolveFieldPath`, `ConsolidatedResult` (both existing, unchanged).

- [ ] **Step 1: Add `resolveSectionData`, immediately before `renderSection`**

In `steps/publish-to-confluence.ts`, insert this function directly above `function renderSection(...)`:

```ts
function resolveSectionData(
  dataFrom: string | undefined,
  source: 'outputs' | 'data' | undefined,
  arrayPath: string | undefined,
  result: ConsolidatedResult,
  sectionTitle: string,
): unknown {
  const stepEntry = result.steps.find(s => s.stepName === dataFrom);
  if (!stepEntry) {
    throw new Error(`section "${sectionTitle}": no step named "${dataFrom}" in the results`);
  }
  const resolvedSource = source ?? 'outputs';
  const sourceValue = resolvedSource === 'data' ? stepEntry.data : stepEntry.outputs;
  if (resolvedSource === 'data' && sourceValue === undefined) {
    throw new Error(`section "${sectionTitle}": step "${dataFrom}" has no embedded "data" (configure embedArtifacts in consolidate-run-results)`);
  }
  return arrayPath ? resolveFieldPath(sourceValue, arrayPath) : sourceValue;
}
```

- [ ] **Step 2: Replace the inline resolution logic at the top of `renderSection` with a call to it**

Find:

```ts
  const stepEntry = result.steps.find(s => s.stepName === section.dataFrom);
  if (!stepEntry) {
    throw new Error(`section "${section.title}": no step named "${section.dataFrom}" in the results`);
  }
  const source = section.source ?? 'outputs';
  const sourceValue = source === 'data' ? stepEntry.data : stepEntry.outputs;
  if (source === 'data' && sourceValue === undefined) {
    throw new Error(`section "${section.title}": step "${section.dataFrom}" has no embedded "data" (configure embedArtifacts in consolidate-run-results)`);
  }
  const data = section.arrayPath ? resolveFieldPath(sourceValue, section.arrayPath) : sourceValue;

  const layout = section.layout ?? 'keyvalue';
```

Replace with:

```ts
  const data = resolveSectionData(section.dataFrom, section.source, section.arrayPath, result, section.title);

  const layout = section.layout ?? 'keyvalue';
```

- [ ] **Step 3: Run the full test suite to confirm zero regressions**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected: PASS, every existing test, byte-for-byte identical behavior — this is a pure refactor with no new tests of its own (nothing new to test; the existing suite passing unmodified *is* the evidence this refactor is behavior-preserving).

- [ ] **Step 4: Commit**

```bash
git add steps/publish-to-confluence.ts
git commit -m "$(cat <<'EOF'
refactor(publish-to-confluence): extract resolveSectionData helper

Pulls the dataFrom/source/arrayPath resolution out of renderSection into
a standalone function, so the upcoming join-section renderer can reuse
it per source instead of duplicating the same three error paths.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `type: 'join'` sections

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Modify: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: `resolveSectionData` (Task 1), `resolveFieldPath`, `renderFieldValue`, `escapeXhtml` (all existing, unchanged).
- Produces: `JoinSource` (exported type), widened `ReportSection.type`/`ReportSection.join`, `renderJoinSection(section: ReportSection, result: ConsolidatedResult): string`.

- [ ] **Step 1: Add the `JoinSource` type and widen `ReportSection`**

Find:

```ts
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
```

Replace with:

```ts
export interface JoinSource {
  /** Step name, matching ConsolidatedStepEntry.stepName in the results JSON. */
  dataFrom: string;
  /** Which part of that step's entry to read. Default 'outputs'. */
  source?: 'outputs' | 'data';
  /** Dot-path within the selected source to the array to join from. */
  arrayPath?: string;
  /**
   * Dot-path (per item). When set, items from this source merge into a
   * row shared with any other source's item resolving the same key
   * value (outer-join: a key present in only one source still gets a
   * row, with every other source's columns blank). When omitted, every
   * item from this source becomes its own independent row, with every
   * other source's columns blank.
   */
  keyField?: string;
  /** Dot-paths (per item) to extract, with display labels — same shape as every other section's `fields`. */
  fields: ReportField[];
}

export interface ReportSection {
  /** Default 'data'. 'static' ignores every other data-section field below except title/html. 'join' ignores dataFrom/source/arrayPath/layout/fields/groupBy/gantt — see `join` below. */
  type?: 'data' | 'static' | 'join';
  title: string;
  /** Step name, matching ConsolidatedStepEntry.stepName in the results JSON. Required unless type: 'static' or 'join'. */
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
  /** Required when type is 'join'. Each source's array data (independently resolved the same way a plain section's dataFrom/source/arrayPath is) contributes columns and/or merges into shared rows. */
  join?: JoinSource[];
}
```

- [ ] **Step 2: Add `renderJoinSection`, immediately before `renderSection`, after `resolveSectionData`**

```ts
function renderJoinSection(section: ReportSection, result: ConsolidatedResult): string {
  const sources = section.join;
  if (!sources || sources.length === 0) {
    throw new Error(`section "${section.title}": type "join" requires a non-empty "join" array`);
  }

  const columns = sources.flatMap((src, si) => src.fields.map((f, fi) => ({ label: f.label, key: `${si}.${fi}` })));

  const keyedRows = new Map<string, Map<string, string>>();
  const keyOrder: string[] = [];
  const unkeyedRows: Map<string, string>[] = [];

  sources.forEach((src, si) => {
    const data = resolveSectionData(src.dataFrom, src.source, src.arrayPath, result, section.title);
    if (!Array.isArray(data)) {
      throw new Error(`section "${section.title}": join source "${src.dataFrom}" requires array data`);
    }
    data.forEach(item => {
      const cells = new Map<string, string>();
      src.fields.forEach((f, fi) => {
        cells.set(`${si}.${fi}`, renderFieldValue(resolveFieldPath(item, f.field), f, section.title));
      });
      if (src.keyField) {
        const key = String(resolveFieldPath(item, src.keyField) ?? '');
        const existing = keyedRows.get(key);
        if (existing) {
          for (const [k, v] of cells) existing.set(k, v);
        } else {
          keyedRows.set(key, cells);
          keyOrder.push(key);
        }
      } else {
        unkeyedRows.push(cells);
      }
    });
  });

  const allRows = [...keyOrder.map(k => keyedRows.get(k)!), ...unkeyedRows];

  const headerRow = `<tr>${columns.map(c => `<th>${escapeXhtml(c.label)}</th>`).join('')}</tr>`;
  const bodyRows = allRows
    .map(cells => `<tr>${columns.map(c => `<td>${cells.get(c.key) ?? ''}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}
```

- [ ] **Step 3: Wire `type: 'join'` into `renderSection`, right after the existing `type: 'static'` branch**

Find:

```ts
function renderSection(section: ReportSection, result: ConsolidatedResult): string {
  if (section.type === 'static') {
    if (!section.html) {
      throw new Error(`section "${section.title}": type "static" requires html`);
    }
    return `<h2>${escapeXhtml(section.title)}</h2>${section.html}`;
  }

  const data = resolveSectionData(section.dataFrom, section.source, section.arrayPath, result, section.title);
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
  if (section.type === 'join') {
    return `<h2>${escapeXhtml(section.title)}</h2>${renderJoinSection(section, result)}`;
  }

  const data = resolveSectionData(section.dataFrom, section.source, section.arrayPath, result, section.title);
```

- [ ] **Step 4: Write the failing tests**

Append this multi-step result helper to `steps/publish-to-confluence.test.ts`, right after the existing `resultWithStep` function:

```ts
function resultWithSteps(
  entries: Array<{ stepName: string; outputs?: Record<string, unknown>; data?: unknown }>,
) {
  return {
    runMetadata: {},
    generatedAt: 't',
    steps: entries.map(e => ({
      stepName: e.stepName,
      ok: true,
      outputs: e.outputs ?? {},
      data: e.data,
    })),
    summary: { totalSteps: entries.length, succeededCount: entries.length, failedCount: 0 },
  };
}
```

Then append these tests:

```ts
test('renderConfluenceStorageFormat join merges rows from two sources sharing a keyField, in order of first appearance', () => {
  const result = resultWithSteps([
    { stepName: 'inbound', data: [{ fileId: 'f1', path: 'a.csv', rows: 10 }, { fileId: 'f2', path: 'b.csv', rows: 20 }] },
    { stepName: 'outbound', data: [{ fileId: 'f2', size: 200 }, { fileId: 'f1', size: 100 }] },
  ]);
  const sections = [{
    title: 'Files', type: 'join' as const,
    join: [
      { dataFrom: 'inbound', source: 'data' as const, keyField: 'fileId', fields: [{ label: 'Path', field: 'path' }, { label: 'Rows', field: 'rows' }] },
      { dataFrom: 'outbound', source: 'data' as const, keyField: 'fileId', fields: [{ label: 'Size', field: 'size' }] },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h2>Files<\/h2>/);
  assert.match(html, /<th>Path<\/th><th>Rows<\/th><th>Size<\/th>/);
  assert.match(html, /<td>a\.csv<\/td><td>10<\/td><td>100<\/td>/);
  assert.match(html, /<td>b\.csv<\/td><td>20<\/td><td>200<\/td>/);
  const f1Index = html.indexOf('a.csv');
  const f2Index = html.indexOf('b.csv');
  assert.ok(f1Index < f2Index);
});

test('renderConfluenceStorageFormat join produces independent rows for sources with no keyField (union)', () => {
  const result = resultWithSteps([
    { stepName: 'inbound', data: [{ path: 'a.csv', rows: 10 }] },
    { stepName: 'outbound', data: [{ path: 'result.json', rows: 5 }] },
  ]);
  const sections = [{
    title: 'Files', type: 'join' as const,
    join: [
      { dataFrom: 'inbound', source: 'data' as const, fields: [{ label: 'Inbound Path', field: 'path' }, { label: 'Inbound Rows', field: 'rows' }] },
      { dataFrom: 'outbound', source: 'data' as const, fields: [{ label: 'Outbound Path', field: 'path' }, { label: 'Outbound Rows', field: 'rows' }] },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>a\.csv<\/td><td>10<\/td><td><\/td><td><\/td>/);
  assert.match(html, /<td><\/td><td><\/td><td>result\.json<\/td><td>5<\/td>/);
});

test('renderConfluenceStorageFormat join allows mixing a keyed source with an unkeyed source in the same section', () => {
  const result = resultWithSteps([
    { stepName: 'keyed', data: [{ id: 'k1', name: 'Alpha' }] },
    { stepName: 'unkeyed', data: [{ note: 'extra row' }] },
  ]);
  const sections = [{
    title: 'Mixed', type: 'join' as const,
    join: [
      { dataFrom: 'keyed', source: 'data' as const, keyField: 'id', fields: [{ label: 'Name', field: 'name' }] },
      { dataFrom: 'unkeyed', source: 'data' as const, fields: [{ label: 'Note', field: 'note' }] },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<td>Alpha<\/td><td><\/td>/);
  assert.match(html, /<td><\/td><td>extra row<\/td>/);
});

test("renderConfluenceStorageFormat join keeps two sources' same-labeled columns distinct (no collision)", () => {
  const result = resultWithSteps([
    { stepName: 'a', data: [{ path: 'in.csv' }] },
    { stepName: 'b', data: [{ path: 'out.json' }] },
  ]);
  const sections = [{
    title: 'T', type: 'join' as const,
    join: [
      { dataFrom: 'a', source: 'data' as const, fields: [{ label: 'Path', field: 'path' }] },
      { dataFrom: 'b', source: 'data' as const, fields: [{ label: 'Path', field: 'path' }] },
    ],
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<th>Path<\/th><th>Path<\/th>/);
  assert.match(html, /<td>in\.csv<\/td><td><\/td>/);
  assert.match(html, /<td><\/td><td>out\.json<\/td>/);
});

test('renderConfluenceStorageFormat throws when type:"join" has no join array', () => {
  const result = resultWithSteps([{ stepName: 'a' }]);
  const sections = [{ title: 'T', type: 'join' as const }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /type "join" requires a non-empty "join" array/);
});

test('renderConfluenceStorageFormat throws when a join source names a step not present in the results', () => {
  const result = resultWithSteps([{ stepName: 'a', data: [] }]);
  const sections = [{
    title: 'T', type: 'join' as const,
    join: [{ dataFrom: 'missingStep', source: 'data' as const, fields: [{ label: 'X', field: 'x' }] }],
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /no step named "missingStep"/);
});

test('renderConfluenceStorageFormat throws when a join source resolves to non-array data', () => {
  const result = resultWithSteps([{ stepName: 'a', data: { notAnArray: true } }]);
  const sections = [{
    title: 'T', type: 'join' as const,
    join: [{ dataFrom: 'a', source: 'data' as const, fields: [{ label: 'X', field: 'x' }] }],
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /join source "a" requires array data/);
});
```

- [ ] **Step 5: Run the tests to verify they fail, then pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected first: FAIL — `type: 'join'` isn't recognized yet, so every new test either falls through to the `dataFrom`-lookup path (throwing `no step named "undefined"`) or the assertions simply don't match.
After Steps 1–3: expected PASS, all tests (existing + 7 new).

- [ ] **Step 6: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
feat(publish-to-confluence): add type:"join" sections

Combines multiple named steps' array data into one table. Sources
sharing a keyField merge into one row (outer join); sources without one
contribute independent rows, populated only in their own columns — a
plain union for the common case where no reliable shared key exists.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `gantt.minDurationS` filter + final verification gate

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Modify: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: `sanitizeMermaidText`, `toMermaidTimestamp`, `partitionByKey`, `resolveFieldPath` (all existing, unchanged).
- Produces: `resolveGanttEndDate` (renamed from `resolveGanttEnd`, now returns `Date` instead of a formatted string — internal only, not exported, not directly unit-tested elsewhere).

- [ ] **Step 1: Add `minDurationS` to `GanttConfig`**

Find:

```ts
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
```

Replace with:

```ts
export interface GanttConfig {
  taskField: string;
  startField: string;
  /** Duration in ms; used only if endField is absent on an item. */
  durationField?: string;
  /** ISO timestamp; takes precedence over durationField if both resolve. */
  endField?: string;
  /** Dot-path; groups bars into separate Mermaid `section` blocks, in order of first appearance. */
  sectionField?: string;
  /** Bars whose resolved duration is shorter than this many seconds are dropped before the chart is built. A sectionField/groupBy group left with zero bars after filtering is omitted entirely. */
  minDurationS?: number;
}
```

- [ ] **Step 2: Write the failing tests**

Append these tests to `steps/publish-to-confluence.test.ts`:

```ts
test('renderConfluenceStorageFormat gantt minDurationS drops bars shorter than the threshold (inclusive boundary)', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'Short', s: '2026-07-21T09:00:00.000Z', durationMs: 4000 },
      { name: 'Exact', s: '2026-07-21T09:00:05.000Z', durationMs: 5000 },
      { name: 'Long', s: '2026-07-21T09:00:10.000Z', durationMs: 10000 },
    ],
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs', minDurationS: 5 },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.doesNotMatch(html, /Short :/);
  assert.match(html, /Exact :/);
  assert.match(html, /Long :/);
});

test('renderConfluenceStorageFormat gantt minDurationS omits a sectionField group whose bars are all filtered out', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'TinyA', s: '2026-07-21T09:00:00.000Z', durationMs: 500, pipelineRunId: 'run-1' },
      { name: 'TinyB', s: '2026-07-21T09:00:01.000Z', durationMs: 500, pipelineRunId: 'run-1' },
      { name: 'BigC', s: '2026-07-21T09:00:02.000Z', durationMs: 10000, pipelineRunId: 'run-2' },
    ],
  });
  const sections = [{
    title: 'T', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const,
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs', sectionField: 'pipelineRunId', minDurationS: 5 },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.doesNotMatch(html, /section run-1/);
  assert.match(html, /section run-2/);
  assert.match(html, /BigC :/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected: FAIL — both new tests, since `minDurationS` doesn't filter anything yet (all bars, including "Short"/"TinyA"/"TinyB", currently render).

- [ ] **Step 4: Rename `resolveGanttEnd` to `resolveGanttEndDate` (returns `Date`) and filter bars by duration in `renderGanttSection`**

Find:

```ts
function resolveGanttEnd(item: unknown, gantt: GanttConfig, index: number, sectionTitle: string): string {
  const endRaw = gantt.endField ? resolveFieldPath(item, gantt.endField) : undefined;
  if (endRaw != null) return toMermaidTimestamp(new Date(String(endRaw)));
  const startRaw = resolveFieldPath(item, gantt.startField);
  const durationRaw = gantt.durationField ? resolveFieldPath(item, gantt.durationField) : undefined;
  if (startRaw != null && durationRaw != null) {
    return toMermaidTimestamp(new Date(new Date(String(startRaw)).getTime() + Number(durationRaw)));
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
    const start = toMermaidTimestamp(new Date(String(resolveFieldPath(item, gantt.startField))));
    const end = resolveGanttEnd(item, gantt, index, section.title);
    return { sectionKey, line: `    ${taskName} : ${start}, ${end}` };
  });

  const groups = partitionByKey(bars, bar => bar.sectionKey);
```

Replace with:

```ts
function resolveGanttEndDate(item: unknown, gantt: GanttConfig, index: number, sectionTitle: string): Date {
  const endRaw = gantt.endField ? resolveFieldPath(item, gantt.endField) : undefined;
  if (endRaw != null) return new Date(String(endRaw));
  const startRaw = resolveFieldPath(item, gantt.startField);
  const durationRaw = gantt.durationField ? resolveFieldPath(item, gantt.durationField) : undefined;
  if (startRaw != null && durationRaw != null) {
    return new Date(new Date(String(startRaw)).getTime() + Number(durationRaw));
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

  const bars = data
    .map((item, index) => {
      const sectionKey = gantt.sectionField ? String(resolveFieldPath(item, gantt.sectionField) ?? '') : 'Activities';
      const taskName = sanitizeMermaidText(resolveFieldPath(item, gantt.taskField));
      const startDate = new Date(String(resolveFieldPath(item, gantt.startField)));
      const endDate = resolveGanttEndDate(item, gantt, index, section.title);
      const durationMs = endDate.getTime() - startDate.getTime();
      const line = `    ${taskName} : ${toMermaidTimestamp(startDate)}, ${toMermaidTimestamp(endDate)}`;
      return { sectionKey, line, durationMs };
    })
    .filter(bar => gantt.minDurationS == null || bar.durationMs >= gantt.minDurationS * 1000);

  const groups = partitionByKey(bars, bar => bar.sectionKey);
```

(The rest of `renderGanttSection` — the `body`/`mermaid`/return lines — is unchanged; this replacement ends at the `partitionByKey` call, which now runs on the filtered `bars`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected: PASS, all tests — the two new ones, and every pre-existing gantt test (none set `minDurationS`, so `bar.durationMs >= null...` short-circuits via `gantt.minDurationS == null` and nothing is filtered, reproducing today's exact output).

- [ ] **Step 6: Run the full verification gate**

Run, in order:

```bash
npm test
npm run typecheck
npm run lint
```

Expected: all three exit 0.

- [ ] **Step 7: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
feat(publish-to-confluence): add gantt.minDurationS filter

Drops bars shorter than the configured threshold before building the
Mermaid chart, so a sectionField/groupBy group left with zero surviving
bars is omitted entirely rather than showing an empty heading.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

## Self-Review Notes

- **Spec coverage:** both spec parts have a task — the `resolveSectionData` refactor and `type: 'join'` (Tasks 1–2), and `gantt.minDurationS` (Task 3).
- **Type consistency:** `resolveSectionData`'s signature (Task 1) is used identically by `renderSection` (Task 1) and `renderJoinSection` (Task 2). `resolveGanttEndDate`'s renamed signature (Task 3) is only called once, from `renderGanttSection`, in the same task.
- **No placeholders:** every step shows exact "Find"/"Replace" text or complete new code; every test's expected strings were manually traced against the described algorithm before being written into this plan (column-key merge order, blank-cell population, filter boundary inclusivity) — not guessed.
- **Task ordering:** Task 1 before Task 2 (hard dependency via `resolveSectionData`); Task 3 has no dependency on Task 2 and could theoretically run before it, but is sequenced last for simplicity.
