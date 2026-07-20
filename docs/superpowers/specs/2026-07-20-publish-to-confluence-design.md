# Publish to Confluence (Group E) — Design

## Purpose

This is Group E, the final piece of the run-reporting-and-Confluence
feature set (Groups D1 `extract-adf-run-details` and D2
`consolidate-run-results` are complete). Group E adds
`publish-to-confluence`, a step that reads D2's consolidated run-results
JSON and publishes it as a Confluence Cloud page — creating it on first
run, updating it in place on every run after. Per the original
requirement, this step is segregated into its own pipeline **stage**, not
just another step in an existing job.

## Config & auth

Confluence Cloud only (not Server/Data Center). Auth is Basic Auth with
an email + API token, matching this repo's established "secrets are never
auto-exposed, explicit env mapping" convention (the same pattern already
used for the GPG public key).

```ts
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
}
```

## Update flow — single page, updated in place

Confluence Cloud REST API v1 (`{baseUrl}/rest/api/content`):

1. **Find the existing page**: `GET .../content?spaceKey={spaceKey}&title={pageTitle}&expand=version`. A `results` array with one entry means the page exists; empty means it doesn't.
2. **Exists** → `PUT .../content/{id}` with the current `version.number + 1` (Confluence's API requires an incrementing version number on every update; using the same number as a concurrent update would fail the request, which is intentional optimistic-concurrency behavior — this step does not retry on that conflict, consistent with "no retry of a failed REST call" already established for `trigger-adf-pipeline`/`extract-adf-run-details`).
3. **Doesn't exist** → `POST .../content`, with `ancestors: [{ id: parentPageId }]` included only when `parentPageId` is set.

Both write calls send the same request body shape:
```json
{
  "type": "page",
  "title": "<pageTitle>",
  "space": { "key": "<spaceKey>" },
  "body": { "storage": { "value": "<rendered XHTML>", "representation": "storage" } }
}
```
(`PUT` additionally includes `id` and `version.number`; `POST` additionally includes `ancestors` when a parent is configured.)

This is a single linear flow (search → create-or-update) — no batch/concurrency model, unlike every other step in this feature set, since there's exactly one page being published per invocation.

## Content rendering

`resultsPath`'s JSON (D2's `ConsolidatedResult` shape) is rendered directly into Confluence **storage format** — an XHTML-based format, not plain Markdown or arbitrary HTML — sent as-is via the API. No intermediate conversion step or library.

- A summary table: build metadata (`runMetadata` keys, rendered as rows), `generatedAt`, `totalSteps`/`succeededCount`/`failedCount`.
- A per-step results table: step name, status (Succeeded/Failed), a rendered list of that step's `outputs` (`key: value` pairs), and the `error` message when present.
- Every dynamic string value (step names, output values, error messages, `runMetadata` values) is XHTML-escaped before insertion — required for valid storage format, and prevents any injected markup from a step's output/error text from corrupting the page or introducing unexpected content.

The rendered content is also written to a local artifact file (`confluence-page-content.html`) before the API call — matching this repo's established pattern of writing an audit/debug artifact even for steps whose main effect is an API side-effect (e.g. `trigger-adf-pipeline`'s summary artifact).

## Output

```ts
{
  outputs: {
    pageId: string;
    pageUrl: string;
    action: 'created' | 'updated';
  },
  artifacts: ['confluence-page-content.html'],
}
```

`pageUrl` is constructed from `baseUrl` + the page's `_links.webui` (or equivalent) returned by the API, giving a directly clickable link in pipeline logs/outputs.

## Error handling

- Missing/invalid config (`baseUrl`, `email`, `apiToken`, `spaceKey`, `pageTitle`, `resultsPath` all required) throws synchronously before any network call.
- `resultsPath` file missing or not valid JSON throws before any network call.
- A non-2xx from either the search `GET` or the create/update `PUT`/`POST` throws with the HTTP status and response body, matching the error-message convention established by `trigger-adf-pipeline`/`extract-adf-run-details`.
- No retry on any failure, including a version-conflict `409` from a concurrent update — same "no retry of a one-shot REST call" precedent as the rest of this feature set.

## Pipeline job segregation

A new `Publish` stage, `dependsOn: Deliver`, containing a `publish_confluence` job:

1. `download: current, artifact: step-output` — to read `consolidate-run-results`' JSON artifact (published by `Deliver`'s existing `PublishPipelineArtifact@1`... **note**: `Deliver`'s job does not currently have its own `PublishPipelineArtifact@1` task — only `Generate`'s does. This design adds one to `Deliver`'s job so `consolidateResults`' artifact is actually available to download in the new `Publish` stage; without it, `consolidateResults`' output JSON never leaves the `Deliver` job's local disk.)
2. The `publish-to-confluence` step itself, with Confluence credentials mapped from ADO secret pipeline variables into `env:` (`CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`) the same way `GPG_PUBLIC_KEY` is mapped today.

The **stage** itself gets `condition: succeededOrFailed()` (not `always()` — `always()` is a step/job-level condition; the stage-level equivalent that still respects a fully-skipped upstream is `succeededOrFailed()`), so the `Publish` stage still runs even if something failed inside `Deliver` — consistent with `consolidateResults`' own `condition: always()` one level down. This does **not** close the cross-stage gap already documented in D2's spec: if `Generate` fails, `Deliver` (and therefore `Publish`) is skipped entirely by the pipeline topology, regardless of any condition set here. That remains an explicitly out-of-scope, pre-existing limitation.

## Out of scope

- No retry of a failed Confluence API call (including version conflicts) — matches this feature set's established "no retry of a one-shot REST call" precedent.
- No Confluence Server/Data Center support — Cloud only.
- No new-page-per-run history — single page, updated in place (an explicit, considered choice; real trending happens via the accumulated JSON series elsewhere, not via Confluence page history).
- No Markdown rendering or a generic Markdown→storage-format converter — storage format is generated directly.
- Does not attempt to close the Generate-stage-failure → Publish-stage-skipped gap already documented in D2's spec; only mitigates the analogous in-`Deliver` case via `condition: succeededOrFailed()` on the new stage.
