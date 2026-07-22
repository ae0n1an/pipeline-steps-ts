# Confluence Gantt groupBy + Payload Report Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a Mermaid gantt timestamp bug, extend `groupBy` to work with `layout: 'gantt'` (one chart per group), and add new payload path/size/row-count report sections plus a wiring fix so the outbound row count is computed against the decrypted file, not the still-encrypted download.

**Architecture:** Tasks 1–2 are code changes to one existing file, `steps/publish-to-confluence.ts` (and its test file) — no new files, no new types beyond what already exists. Task 3 is pure config (`configs/*.json`) — no step or `publish-to-confluence.ts` code changes.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-confluence-gantt-groupby-payload-tables-design.md` — re-read it if a task's intent is unclear.
- No new npm dependency. No new files (Tasks 1–2 modify `steps/publish-to-confluence.ts`/`.test.ts` only; Task 3 modifies existing `configs/*.json` files only).
- Every existing test in `steps/publish-to-confluence.test.ts` must keep passing, except the specific assertions this plan explicitly updates (the Z-suffix removals in Task 1, and the single replaced test in Task 2) — do not touch any other existing test.
- Test command for the step file: `npx tsx --test "steps/publish-to-confluence.test.ts"`.
- Full-repo gate before Task 3's final commit: `npm test`, `npm run typecheck`, `npm run lint` must all pass.
- Every field name used in Task 3's new config sections has already been verified against the real, current contents of the upstream configs (`configs/generate-users-csv.json`, `configs/gpg-encrypt-users-csv.json`, `configs/upload-to-blob.json`, `configs/gpg-decrypt-result.json`, `configs/verify-row-count.json`) — use them exactly as given in Task 3, don't re-derive or guess.

---

### Task 1: Fix trailing `Z` in Mermaid gantt timestamps

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Modify: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Produces: `toMermaidTimestamp(date: Date): string` — a new local helper, used by `resolveGanttEnd` and `renderGanttSection`. Not exported (matches this file's convention of only exporting things worth unit-testing directly, per existing helpers like `sanitizeMermaidText`).
- Consumes: nothing new.

- [ ] **Step 1: Update the existing tests' expected strings to the fixed (no trailing `Z`) form**

In `steps/publish-to-confluence.test.ts`, three assertions currently expect a trailing `Z` on both the start and end timestamp of a rendered gantt bar. Update each to drop it.

Find (in `'renderConfluenceStorageFormat renders a gantt layout as a Mermaid code-block macro using durationField'`):

```ts
  assert.match(html, /CopyData : 2026-07-21T09:00:00\.000Z, 2026-07-21T09:00:30\.000Z/);
```

Replace with:

```ts
  assert.match(html, /CopyData : 2026-07-21T09:00:00\.000, 2026-07-21T09:00:30\.000/);
```

Find (in `'renderConfluenceStorageFormat gantt prefers endField over durationField when both resolve'`):

```ts
  assert.match(html, /A : 2026-07-21T09:00:00\.000Z, 2026-07-21T09:05:00\.000Z/);
```

Replace with:

```ts
  assert.match(html, /A : 2026-07-21T09:00:00\.000, 2026-07-21T09:05:00\.000/);
```

Find (in `'runAll renders a full page combining format, groupBy, gantt, static sections, and includeToc'`):

```ts
    assert.match(content, /CopyData : 2026-07-21T04:00:00\.000Z, 2026-07-21T04:00:30\.000Z/);
```

Replace with:

```ts
    assert.match(content, /CopyData : 2026-07-21T04:00:00\.000, 2026-07-21T04:00:30\.000/);
```

- [ ] **Step 2: Run the tests to verify these three fail**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected: FAIL — exactly these 3 tests, because the code still emits a trailing `Z` that the updated regexes (with no `Z`) no longer match. All other tests still pass.

- [ ] **Step 3: Add `toMermaidTimestamp` and use it everywhere a bar timestamp is built**

In `steps/publish-to-confluence.ts`, add this function immediately after `sanitizeMermaidText`:

```ts
function sanitizeMermaidText(value: unknown): string {
  return String(value ?? '').replace(/:/g, '');
}

function toMermaidTimestamp(date: Date): string {
  return date.toISOString().replace(/Z$/, '');
}
```

Then, in `resolveGanttEnd`, find:

```ts
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
```

Replace with:

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
```

Then, in `renderGanttSection`, find:

```ts
    const start = new Date(String(resolveFieldPath(item, gantt.startField))).toISOString();
```

Replace with:

```ts
    const start = toMermaidTimestamp(new Date(String(resolveFieldPath(item, gantt.startField))));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected: PASS, all tests (the 3 updated ones and everything else).

- [ ] **Step 5: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
fix(publish-to-confluence): strip trailing Z from Mermaid gantt timestamps

The gantt dateFormat directive declares no timezone/UTC token, but every
bar's start/end was built via toISOString(), which always appends one —
left dangling and unparsed by Mermaid's date parser.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `groupBy` support for `layout: 'gantt'`

**Files:**
- Modify: `steps/publish-to-confluence.ts`
- Modify: `steps/publish-to-confluence.test.ts`

**Interfaces:**
- Consumes: `renderGanttSection` (unchanged signature, from Task 1's file state), `partitionByKey` (existing, unchanged).
- Produces: nothing new exported — a widened `groupBy` branch inside the existing `renderSection` function.

- [ ] **Step 1: Replace the "groupBy + gantt throws" test with a still-must-throw case, and add two new tests for the new behavior**

In `steps/publish-to-confluence.test.ts`, find:

```ts
test('renderConfluenceStorageFormat throws when groupBy is combined with layout:"gantt"', () => {
  const result = resultWithStep('a', { data: [{ x: 1 }] });
  const sections = [{
    title: 'G', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const, groupBy: 'x',
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /groupBy is not supported on layout "gantt"/);
});
```

Replace with:

```ts
test('renderConfluenceStorageFormat throws when groupBy is combined with layout:"keyvalue"', () => {
  const result = resultWithStep('a', { data: [{ x: 1 }] });
  const sections = [{
    title: 'G', dataFrom: 'a', source: 'data' as const, layout: 'keyvalue' as const, groupBy: 'x',
  }];
  assert.throws(() => renderConfluenceStorageFormat(result, sections), /groupBy is not supported on layout "keyvalue"/);
});

test('renderConfluenceStorageFormat groupBy on layout:"gantt" renders one independent chart per group, in order of first appearance', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'A1', s: '2026-07-21T09:00:00.000Z', durationMs: 1000, topLevelRunId: 'run-1' },
      { name: 'B1', s: '2026-07-21T09:00:01.000Z', durationMs: 1000, topLevelRunId: 'run-2' },
      { name: 'A2', s: '2026-07-21T09:00:02.000Z', durationMs: 1000, topLevelRunId: 'run-1' },
    ],
  });
  const sections = [{
    title: 'Timeline', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const, groupBy: 'topLevelRunId',
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /<h2>Timeline<\/h2>/);
  assert.match(html, /<h3>run-1<\/h3>/);
  assert.match(html, /<h3>run-2<\/h3>/);
  assert.match(html, /title Timeline — run-1/);
  assert.match(html, /title Timeline — run-2/);
  const h3Run1 = html.indexOf('<h3>run-1</h3>');
  const h3Run2 = html.indexOf('<h3>run-2</h3>');
  const a1Index = html.indexOf('A1 :');
  const a2Index = html.indexOf('A2 :');
  const b1Index = html.indexOf('B1 :');
  assert.ok(h3Run1 < a1Index);
  assert.ok(a1Index < a2Index);
  assert.ok(a2Index < h3Run2);
  assert.ok(h3Run2 < b1Index);
  // Two independent code-block macros, one per group.
  const codeBlockCount = (html.match(/ac:name="code"/g) ?? []).length;
  assert.equal(codeBlockCount, 2);
});

test('renderConfluenceStorageFormat groupBy on layout:"gantt" still applies gantt.sectionField within each group\'s chart', () => {
  const result = resultWithStep('a', {
    data: [
      { name: 'A1', s: '2026-07-21T09:00:00.000Z', durationMs: 1000, topLevelRunId: 'run-1', childRunId: 'child-1' },
      { name: 'A2', s: '2026-07-21T09:00:01.000Z', durationMs: 1000, topLevelRunId: 'run-1', childRunId: 'child-2' },
    ],
  });
  const sections = [{
    title: 'Timeline', dataFrom: 'a', source: 'data' as const, layout: 'gantt' as const, groupBy: 'topLevelRunId',
    gantt: { taskField: 'name', startField: 's', durationField: 'durationMs', sectionField: 'childRunId' },
  }];
  const html = renderConfluenceStorageFormat(result, sections);
  assert.match(html, /section child-1/);
  assert.match(html, /section child-2/);
});
```

- [ ] **Step 2: Run the tests to verify the new behavior tests fail**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected: the two new tests (`"renders one independent chart per group..."` and `"still applies gantt.sectionField..."`) FAIL, because `renderSection` still throws `groupBy is not supported on layout "gantt"` before either test's assertions can be reached. The replaced `"keyvalue"` test passes immediately (keyvalue was already, and remains, unsupported by `groupBy` — this is a like-for-like replacement of an existing true statement, not new behavior; only the two `gantt` tests above are the actual RED-to-GREEN target of this task).

- [ ] **Step 3: Widen the `groupBy` guard and dispatch in `renderSection`**

In `steps/publish-to-confluence.ts`, find:

```ts
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
```

Replace with:

```ts
  if (section.groupBy) {
    if (layout !== 'table' && layout !== 'bullets' && layout !== 'gantt') {
      throw new Error(`section "${section.title}": groupBy is not supported on layout "${layout}"`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`section "${section.title}": groupBy requires array data`);
    }
    const groupBy = section.groupBy;
    const groups = partitionByKey(data, item => String(resolveFieldPath(item, groupBy) ?? ''));
    const body = groups
      .map(({ key, items }) => {
        const groupBody = layout === 'table' ? renderTableSection(section, items)
          : layout === 'bullets' ? renderBulletsSection(section, items)
          : renderGanttSection({ ...section, title: `${section.title} — ${key}` }, items);
        return `<h3>${escapeXhtml(key)}</h3>${groupBody}`;
      })
      .join('');
    return `<h2>${escapeXhtml(section.title)}</h2>${body}`;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test "steps/publish-to-confluence.test.ts"`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add steps/publish-to-confluence.ts steps/publish-to-confluence.test.ts
git commit -m "$(cat <<'EOF'
feat(publish-to-confluence): support groupBy on layout:"gantt"

Renders one independent Mermaid chart per distinct groupBy value
(e.g. one timeline per ADF run), each still able to use gantt.sectionField
internally to split that group's own child pipelines.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Payload report sections + wiring fix + verification gate

**Files:**
- Modify: `configs/verify-row-count.json`
- Modify: `configs/validate-json-schema.json`
- Modify: `configs/consolidate-run-results.json`
- Modify: `configs/publish-to-confluence.json`

**Interfaces:**
- Consumes: real output-key names already verified against `steps/generate-synthetic-csv.ts`, `steps/gpg-encrypt-file.ts`, `steps/upload-to-blob.ts`, `steps/gpg-decrypt-file.ts`, `steps/verify-row-count.ts` (all unchanged by this task — config only).

- [ ] **Step 1: Fix the row-count/schema wiring to read the decrypted output**

In `configs/verify-row-count.json`, find:

```json
{
  "files": [
    {
      "name": "outboundResult",
      "filePath": "{{steps.verifyResult.outputs.result_localPath}}",
      "format": "json",
      "minRows": 1
    }
  ]
}
```

Replace with:

```json
{
  "files": [
    {
      "name": "outboundResult",
      "filePath": "{{steps.gpgDecryptResult.outputs.result_decryptedPath}}",
      "format": "json",
      "minRows": 1
    }
  ]
}
```

In `configs/validate-json-schema.json`, find:

```json
{
  "files": [
    {
      "name": "outboundResult",
      "filePath": "{{steps.verifyResult.outputs.result_localPath}}",
      "schemaPath": "configs/schemas/outbound-result-schema.json"
    }
  ]
}
```

Replace with:

```json
{
  "files": [
    {
      "name": "outboundResult",
      "filePath": "{{steps.gpgDecryptResult.outputs.result_decryptedPath}}",
      "schemaPath": "configs/schemas/outbound-result-schema.json"
    }
  ]
}
```

- [ ] **Step 2: Add the two new step names to `consolidate-run-results.json`**

Find:

```json
{
  "stepNames": [
    "genUsersCsv",
    "gpgEncryptCsv",
    "waitForTrigger",
    "executeAdf",
    "pollAdf",
    "extractAdfDetails",
    "verifyResult",
    "verifyRowCount",
    "validateSchema",
    "validateBusinessLogic"
  ],
  "embedArtifacts": {
    "extractAdfDetails": "adf-run-details.json"
  },
  "runMetadata": {
    "buildId": "{{env.BUILD_BUILDID}}",
    "branch": "{{env.BUILD_SOURCEBRANCH}}"
  }
}
```

Replace with:

```json
{
  "stepNames": [
    "genUsersCsv",
    "gpgEncryptCsv",
    "uploadPayload",
    "waitForTrigger",
    "executeAdf",
    "pollAdf",
    "extractAdfDetails",
    "verifyResult",
    "gpgDecryptResult",
    "verifyRowCount",
    "validateSchema",
    "validateBusinessLogic"
  ],
  "embedArtifacts": {
    "extractAdfDetails": "adf-run-details.json"
  },
  "runMetadata": {
    "buildId": "{{env.BUILD_BUILDID}}",
    "branch": "{{env.BUILD_SOURCEBRANCH}}"
  }
}
```

(`uploadPayload` and `gpgDecryptResult` are added to `stepNames` only — deliberately no `embedArtifacts` entry for either, per the spec's cross-stage-path reasoning: `uploadPayload` runs in the Generate stage, a different stage than where `consolidateResults` runs, so its `upload-summary.json` artifact's recorded absolute path isn't safe to `embedArtifacts`-read from Deliver. The new sections in Step 3 use each step's flat `outputs` instead.)

- [ ] **Step 3: Add the five new sections to `configs/publish-to-confluence.json`**

Find the end of the `sections` array (the closing of the `"Business Logic Validation"` section, immediately before the array's closing `]`):

```json
    {
      "title": "Business Logic Validation",
      "dataFrom": "validateBusinessLogic",
      "layout": "bullets"
    }
  ]
}
```

Replace with:

```json
    {
      "title": "Business Logic Validation",
      "dataFrom": "validateBusinessLogic",
      "layout": "bullets"
    },
    {
      "title": "Generated CSV",
      "dataFrom": "genUsersCsv",
      "layout": "keyvalue",
      "fields": [
        { "label": "Path", "field": "usersCsv_csvPath" },
        { "label": "Rows", "field": "usersCsv_rowCount" },
        { "label": "Size", "field": "usersCsv_sizeBytes", "format": "bytes" }
      ]
    },
    {
      "title": "Encrypted Payload",
      "dataFrom": "gpgEncryptCsv",
      "layout": "keyvalue",
      "fields": [
        { "label": "Path", "field": "usersCsvGpg_encryptedPath" },
        { "label": "Size", "field": "usersCsvGpg_sizeBytes", "format": "bytes" }
      ]
    },
    {
      "title": "Uploaded Blob",
      "dataFrom": "uploadPayload",
      "layout": "keyvalue",
      "fields": [
        { "label": "Blob Path", "field": "usersCsvGpg_blobPath" },
        { "label": "Size", "field": "usersCsvGpg_sizeBytes", "format": "bytes" },
        { "label": "Status", "field": "usersCsvGpg_status", "format": "status" }
      ]
    },
    {
      "title": "Decrypted Output",
      "dataFrom": "gpgDecryptResult",
      "layout": "keyvalue",
      "fields": [
        { "label": "Path", "field": "result_decryptedPath" },
        { "label": "Size", "field": "result_sizeBytes", "format": "bytes" }
      ]
    },
    {
      "title": "Output Row Count",
      "dataFrom": "verifyRowCount",
      "layout": "keyvalue",
      "fields": [
        { "label": "Rows", "field": "outboundResult_rowCount" }
      ]
    }
  ]
}
```

- [ ] **Step 4: Validate every edited config file is still valid JSON**

Run:

```bash
for f in configs/verify-row-count.json configs/validate-json-schema.json configs/consolidate-run-results.json configs/publish-to-confluence.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f', 'utf8')); console.log('$f: valid JSON')"
done
```

Expected: all four print `<path>: valid JSON`, no errors.

- [ ] **Step 5: Run the full verification gate**

Run, in order:

```bash
npm test
npm run typecheck
npm run lint
```

Expected: all three exit 0. (This is a config-only task — the full suite passing here confirms nothing in `publish-to-confluence.ts`'s rendering logic rejects the new `keyvalue` sections' field names, e.g. no `no step named "..."` or `unknown format` errors would only surface at actual render time against a real `run-results.json`, which this gate doesn't exercise — that's expected; see the spec's "Testing" section, which states Part 2 is config-only and verified via full-suite-pass + the field-name cross-check already performed when writing the spec.)

- [ ] **Step 6: Commit**

```bash
git add configs/verify-row-count.json configs/validate-json-schema.json configs/consolidate-run-results.json configs/publish-to-confluence.json
git commit -m "$(cat <<'EOF'
feat: add payload report sections; fix row-count/schema to read decrypted output

Wires verify-row-count and validate-json-schema to gpgDecryptResult's
decrypted output instead of the still-encrypted download, adds
uploadPayload/gpgDecryptResult to consolidate-run-results' stepNames, and
adds five new keyvalue sections surfacing the generated/encrypted/
uploaded/decrypted payload's path, size, and row count in the Confluence
report.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

## Self-Review Notes

- **Spec coverage:** every part of the spec has a task — the Z-suffix fix (Task 1), `groupBy` + `gantt` (Task 2), and the wiring fix + `stepNames` + five new sections (Task 3, all three sub-parts of Part 2).
- **Type consistency:** `toMermaidTimestamp(date: Date): string` (Task 1) is used identically in both call sites in Task 1 itself; Task 2 doesn't introduce any new function signatures, only widens an existing conditional and adds one ternary branch calling the existing `renderGanttSection` with its existing signature.
- **No placeholders:** every step shows the exact "Find"/"Replace" text or exact new file content; Task 3's field names are the real, previously-verified output keys, not placeholders.
- **Task ordering:** Task 2 depends on Task 1 (its new tests' expected Mermaid strings assume no trailing `Z`) — must run in order 1, 2, 3.
