# Composable TypeScript Steps for Azure Pipelines

Each pipeline step is a standalone TS module with a uniform, typed contract:
**config in → JSON outputs + file artifacts out**. Steps compose in YAML;
outputs flow between them without steps knowing about each other.

## Layout

```
runner/
  types.ts        # StepModule / StepContext / StepResult + defineStep()
  run-step.ts     # generic runner (the only framework code)
steps/
  lib/
    blob-client.ts             # shared Azure Blob Storage client (real + fake, used by the 3 steps below)
  generate-synthetic-csv.ts   # mock CSV from typed column configs
  gpg-encrypt-file.ts         # GPG-encrypt with a key from Azure Key Vault
  trigger-adf-pipeline.ts     # trigger + poll ADF pipeline run(s) in parallel
  remove-blob-files.ts        # delete blobs matching a glob path pattern
  upload-to-blob.ts           # upload local file(s) to blob storage
  verify-and-download-blob.ts # verify expected blob(s) exist and download them
configs/
  generate-users-csv.json
  gpg-encrypt-users-csv.json
  trigger-adf-pipelines.json
  remove-blob-files.json
  upload-to-blob.json
  verify-and-download-blob.json
azure-pipelines.yml
tsconfig.json     # strict, noEmit (tsx executes TS directly)
```

## The step contract (typed)

```ts
import { defineStep } from '../runner/types';

export interface MyConfig { inputPath: string; retries?: number; }

export default defineStep<MyConfig>({
  async run(config, ctx) {          // config: MyConfig, ctx: StepContext
    return {
      outputs:   { resultPath: '…' },
      artifacts: ['…'],
    };
  },
});
```

`defineStep<TConfig>()` gives you full inference inside `run` — the CSV step's
column definitions are a discriminated union, so invalid combinations
(e.g. `values` on an `int` column) fail `npm run typecheck`.

The one exception to "every step is standalone": the three blob-storage
steps share `steps/lib/blob-client.ts` for Azure auth/client setup, since
duplicating it three times bought nothing.

## Running

```bash
npm ci
npm run typecheck                 # tsc --noEmit gate

npx tsx runner/run-step.ts \
  --step steps/generate-synthetic-csv.ts \
  --config configs/generate-users-csv.json \
  --name genUsersCsv

export GPG_PUBLIC_KEY="$(gpg --armor --export you@example.com)"  # simulate Key Vault
npx tsx runner/run-step.ts \
  --step steps/gpg-encrypt-file.ts \
  --config configs/gpg-encrypt-users-csv.json \
  --name gpgEncryptCsv
```

Trigger ADF pipelines (needs an ARM access token — see the `AzureCLI@2` task
in `.pipelines/azure-pipelines.yml`, or `az account get-access-token
--resource https://management.azure.com/` locally):

```bash
export ADF_ACCESS_TOKEN="$(az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv)"
npx tsx runner/run-step.ts \
  --step steps/trigger-adf-pipeline.ts \
  --config configs/trigger-adf-pipelines.json \
  --name triggerAdf
```

Blob storage steps (need `DefaultAzureCredential` to resolve — e.g.
`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` env vars, or `az
login` locally):

```bash
npx tsx runner/run-step.ts \
  --step steps/remove-blob-files.ts \
  --config configs/remove-blob-files.json \
  --name cleanupInbound

npx tsx runner/run-step.ts \
  --step steps/upload-to-blob.ts \
  --config configs/upload-to-blob.json \
  --name uploadPayload

npx tsx runner/run-step.ts \
  --step steps/verify-and-download-blob.ts \
  --config configs/verify-and-download-blob.json \
  --name verifyResult
```

No build/dist step: `tsx` executes TypeScript directly, in the pipeline and
locally. If you prefer compiled output, flip `noEmit` off, add `outDir`, and
run `node dist/runner/run-step.js` instead.

## How outputs flow

1. **Config interpolation** — `"inputPath": "{{steps.genUsersCsv.outputs.usersCsv_csvPath}}"`
   resolved from the upstream `output.json`; `{{env.VAR}}` also works.
2. **Pipeline output variables** — every output is emitted via
   `##vso[task.setvariable …;isOutput=true]`; read as
   `$(genUsersCsv.genUsersCsv.usersCsv_rowCount)` or via
   `stageDependencies`. `generate-synthetic-csv`, `gpg-encrypt-file`, and
   `trigger-adf-pipeline` all support multiple items per invocation, and
   all three flatten each item's outputs under a prefix — that item's
   configured `name` (or `f0`, `f1`, … / `p0`, `p1`, … by index if `name`
   is omitted), e.g. `$(triggerAdf.triggerAdf.copyOrders_status)`.
3. **Published artifacts** — the `step-output/` tree is published whole.

## Azure Key Vault

Store the ASCII-armored GPG **public** key as secret `gpg-public-key`.
The `AzureKeyVault@2` task pulls it into `$(gpg-public-key)`, and the YAML
maps it into the step env (`GPG_PUBLIC_KEY`) — required, secrets are never
auto-exposed. The step imports it into an ephemeral keyring (deleted after),
auto-detects the recipient fingerprint, encrypts, and emits the `.gpg`
artifact. Alternative: set `keyVaultUrl` + `secretName` in the config and
install `@azure/identity @azure/keyvault-secrets` for direct SDK fetch.
Only the public key ever touches the pipeline.

## Azure Blob Storage

`remove-blob-files`, `upload-to-blob`, and `verify-and-download-blob` all
authenticate via `DefaultAzureCredential` against an `accountUrl` — no
connection string or SAS token. In Azure Pipelines, export the service
connection's SPN as environment variables via `AzureCLI@2`'s
`addSpnToEnvironment: true` (see `.pipelines/azure-pipelines.yml`) and map
`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` into each blob
step's `env`; `DefaultAzureCredential`'s `EnvironmentCredential` fallback
picks these up automatically. Locally, `az login` is enough (via
`DefaultAzureCredential`'s `AzureCliCredential` fallback).

## Prior art

If you need org-wide reusable tasks with a UI in the pipeline editor, the
official path is custom task extensions with `azure-pipelines-task-lib`
(TypeScript, task.json inputs, published via tfx). This repo is the
lightweight in-repo alternative; a step's `run(config, ctx)` body ports to a
task-lib task almost mechanically if you outgrow it.
