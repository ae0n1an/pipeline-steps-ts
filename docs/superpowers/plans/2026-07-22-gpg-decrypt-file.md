# gpg-decrypt-file Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `gpg-decrypt-file` step that decrypts GPG-encrypted files using a private key sourced from Azure Key Vault (two delivery routes, mirroring the existing `gpg-encrypt-file` step), with optional passphrase support.

**Architecture:** One new self-contained step file (`steps/gpg-decrypt-file.ts`) mirroring `gpg-encrypt-file.ts`'s batch-of-files / ephemeral-`GNUPGHOME` / two-key-delivery-route pattern in reverse (private key + `gpg --decrypt` instead of public key + `gpg --encrypt`), plus a new optional passphrase resolution path. No shared lib, no new step-runner changes.

**Tech Stack:** TypeScript, Node's `node:child_process.execFileSync` to shell out to the real `gpg` CLI (same as `gpg-encrypt-file.ts`), `node:test` + `node:assert/strict` for tests (which exercise real `gpg` — no mocking of the CLI).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-gpg-decrypt-file-design.md` — re-read it if a task's intent is unclear.
- No new npm dependency required for the primary path — `@azure/identity`/`@azure/keyvault-secrets` stay optional (lazy `import()`), exactly like `gpg-encrypt-file.ts`.
- Every new thrown error is either a bare, specific message (`Input file not found: ...`, `No usable GPG private key. ...`, `passphraseSecretName requires keyVaultUrl`) at the per-file level, or wrapped by the outer loop as `File entry <index> ("<name>") failed: <message>` — matching `gpg-encrypt-file.ts`'s exact conventions.
- Test command for this file only: `npx tsx --test "steps/gpg-decrypt-file.test.ts"`.
- Full-repo gate before the final commit: `npm test`, `npm run typecheck`, `npm run lint` must all pass.
- Tests shell out to the real `gpg` CLI (already required/available in this environment, same as `gpg-encrypt-file.test.ts`) — do not mock `execFileSync`.
- Fail-fast loop semantics: the very first file entry that throws stops the batch immediately; later entries in `files` are never attempted. This matches `gpg-encrypt-file.ts` exactly — do not make this step aggregate-and-continue.

---

### Task 1: `gpg-decrypt-file.ts` step + test suite

**Files:**
- Create: `steps/gpg-decrypt-file.ts`
- Create: `steps/gpg-decrypt-file.test.ts`

**Interfaces:**
- Produces: `FileEntryConfig`, `GpgDecryptConfig`, and the step's default export (`defineStep<GpgDecryptConfig>({ run(config, ctx) {...} })`) — the same shape `runner/run-step.ts` already expects from every other step (see `steps/gpg-encrypt-file.ts` for the exact pattern this mirrors).
- Consumes: `StepContext`/`StepResult`/`defineStep` from `../runner/types` (unchanged).

- [ ] **Step 1: Write the failing test suite**

Create `steps/gpg-decrypt-file.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import step from './gpg-decrypt-file';
import type { StepContext } from '../runner/types';

let testGnupgHome: string;
let keyNoPass: { publicKey: string; privateKey: string };
let keyWithPass: { publicKey: string; privateKey: string };
const PASSPHRASE = 'test-passphrase-123';
const UID_NO_PASS = 'No Pass <nopass@example.com>';
const UID_WITH_PASS = 'With Pass <withpass@example.com>';

function genTestKeypair(uid: string, passphrase: string): { publicKey: string; privateKey: string } {
  execFileSync(
    'gpg',
    ['--batch', '--passphrase', passphrase, '--quick-gen-key', uid, 'default', 'default', 'never'],
    { env: { ...process.env, GNUPGHOME: testGnupgHome } },
  );
  const publicKey = execFileSync('gpg', ['--armor', '--export', uid], {
    env: { ...process.env, GNUPGHOME: testGnupgHome },
    encoding: 'utf8',
  });
  const privateKey = execFileSync(
    'gpg',
    ['--batch', '--pinentry-mode', 'loopback', '--passphrase', passphrase, '--armor', '--export-secret-keys', uid],
    { env: { ...process.env, GNUPGHOME: testGnupgHome }, encoding: 'utf8' },
  );
  return { publicKey, privateKey };
}

function encryptForTest(recipientUid: string, plaintext: string, outputPath: string): void {
  const inputPath = `${outputPath}.plain`;
  fs.writeFileSync(inputPath, plaintext);
  execFileSync(
    'gpg',
    ['--batch', '--yes', '--trust-model', 'always', '--recipient', recipientUid, '--output', outputPath, '--encrypt', inputPath],
    { env: { ...process.env, GNUPGHOME: testGnupgHome } },
  );
}

function fakeCtx(outDir: string): StepContext {
  return { stepName: 'test', outDir, workspace: outDir, steps: {}, log: () => {}, warn: () => {} };
}

before(() => {
  testGnupgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gnupg-decrypt-test-'));
  fs.chmodSync(testGnupgHome, 0o700);
  keyNoPass = genTestKeypair(UID_NO_PASS, '');
  keyWithPass = genTestKeypair(UID_WITH_PASS, PASSPHRASE);
});

after(() => {
  fs.rmSync(testGnupgHome, { recursive: true, force: true });
});

test('decrypts a single file with a passphrase-less private key', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    const encryptedPath = path.join(outDir, 'input.gpg');
    encryptForTest(UID_NO_PASS, 'hello from file A\n', encryptedPath);
    const config = {
      files: [{ name: 'fileA', inputPath: encryptedPath, privateKeyArmored: keyNoPass.privateKey }],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.totalFiles, 1);
    assert.equal(result.outputs?.fileA_fileName, 'input');
    const decryptedPath = result.outputs?.fileA_decryptedPath as string;
    assert.equal(fs.readFileSync(decryptedPath, 'utf8'), 'hello from file A\n');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('decrypts with a passphrase-protected private key when passphrase is supplied', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    const encryptedPath = path.join(outDir, 'secret.gpg');
    encryptForTest(UID_WITH_PASS, 'protected payload\n', encryptedPath);
    const config = {
      files: [{ name: 'fileB', inputPath: encryptedPath, privateKeyArmored: keyWithPass.privateKey, passphrase: PASSPHRASE }],
    };
    const result = await step.run(config, fakeCtx(outDir));
    const decryptedPath = result.outputs?.fileB_decryptedPath as string;
    assert.equal(fs.readFileSync(decryptedPath, 'utf8'), 'protected payload\n');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails when a passphrase-protected key is decrypted without a passphrase', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    const encryptedPath = path.join(outDir, 'secret2.gpg');
    encryptForTest(UID_WITH_PASS, 'protected payload 2\n', encryptedPath);
    const config = {
      files: [{ name: 'fileC', inputPath: encryptedPath, privateKeyArmored: keyWithPass.privateKey }],
    };
    await assert.rejects(() => step.run(config, fakeCtx(outDir)), /File entry 0 \("fileC"\) failed:/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('decrypts multiple files with different keys and distinct output names', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    const encA = path.join(outDir, 'a.gpg');
    const encB = path.join(outDir, 'b.gpg');
    encryptForTest(UID_NO_PASS, 'payload A\n', encA);
    encryptForTest(UID_WITH_PASS, 'payload B\n', encB);
    const config = {
      files: [
        { name: 'outA', inputPath: encA, privateKeyArmored: keyNoPass.privateKey, outputFileName: 'a.txt' },
        { name: 'outB', inputPath: encB, privateKeyArmored: keyWithPass.privateKey, passphrase: PASSPHRASE, outputFileName: 'b.txt' },
      ],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.totalFiles, 2);
    assert.equal(fs.readFileSync(result.outputs?.outA_decryptedPath as string, 'utf8'), 'payload A\n');
    assert.equal(fs.readFileSync(result.outputs?.outB_decryptedPath as string, 'utf8'), 'payload B\n');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('defaults the output filename by stripping a trailing .gpg/.asc, else appending .decrypted', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    const encAsc = path.join(outDir, 'report.csv.asc');
    encryptForTest(UID_NO_PASS, 'csv data\n', encAsc);
    const config = { files: [{ name: 'r', inputPath: encAsc, privateKeyArmored: keyNoPass.privateKey }] };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.r_fileName, 'report.csv');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when two entries default or specify the same output filename', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    const encA = path.join(outDir, 'a.gpg');
    const encB = path.join(outDir, 'b.gpg');
    encryptForTest(UID_NO_PASS, 'payload A\n', encA);
    encryptForTest(UID_NO_PASS, 'payload B\n', encB);
    const config = {
      files: [
        { name: 'outA', inputPath: encA, privateKeyArmored: keyNoPass.privateKey, outputFileName: 'same.txt' },
        { name: 'outB', inputPath: encB, privateKeyArmored: keyNoPass.privateKey, outputFileName: 'same.txt' },
      ],
    };
    await assert.rejects(
      async () => step.run(config, fakeCtx(outDir)),
      /File entry 1 \("outB"\) failed:.*same\.txt.*already used/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast when an input file is missing, naming the entry', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    const config = {
      files: [{ name: 'missing', inputPath: path.join(outDir, 'nope.gpg'), privateKeyArmored: keyNoPass.privateKey }],
    };
    await assert.rejects(
      async () => step.run(config, fakeCtx(outDir)),
      /File entry 0 \("missing"\) failed:.*Input file not found/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when config.files is empty', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    await assert.rejects(
      async () => step.run({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when no usable private key is provided', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    const encA = path.join(outDir, 'a.gpg');
    encryptForTest(UID_NO_PASS, 'payload\n', encA);
    const config = { files: [{ name: 'noKey', inputPath: encA }] };
    await assert.rejects(
      async () => step.run(config, fakeCtx(outDir)),
      /File entry 0 \("noKey"\) failed:.*No usable GPG private key/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when passphraseSecretName is set without keyVaultUrl', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    const encA = path.join(outDir, 'a.gpg');
    encryptForTest(UID_WITH_PASS, 'payload\n', encA);
    const config = {
      files: [{ name: 'badCfg', inputPath: encA, privateKeyArmored: keyWithPass.privateKey, passphraseSecretName: 'my-passphrase' }],
    };
    await assert.rejects(
      async () => step.run(config, fakeCtx(outDir)),
      /File entry 0 \("badCfg"\) failed:.*passphraseSecretName requires keyVaultUrl/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test "steps/gpg-decrypt-file.test.ts"`
Expected: FAIL — `./gpg-decrypt-file` does not exist yet (module not found).

- [ ] **Step 3: Write the implementation**

Create `steps/gpg-decrypt-file.ts`:

```ts
/**
 * Step: gpg-decrypt-file (TypeScript)
 *
 * Decrypts one or more GPG-encrypted files, each with its own private key,
 * sourced from Azure Key Vault. Mirrors gpg-encrypt-file.ts's batch/key-
 * delivery/ephemeral-keyring pattern in reverse.
 * Route A (recommended): AzureKeyVault@2 task -> pipeline variable ->
 *   env mapping -> "privateKeyArmored": "{{env.GPG_PRIVATE_KEY}}"
 * Route B: "keyVaultUrl" + "secretName" -> fetched via
 *   @azure/identity + @azure/keyvault-secrets (optional deps).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defineStep, type StepContext } from '../runner/types';

export interface FileEntryConfig {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  /** Encrypted file to decrypt, usually {{steps.verifyResult.outputs.<name>_localPath}}. */
  inputPath: string;
  /** ASCII-armored private key, usually {{env.GPG_PRIVATE_KEY}}. */
  privateKeyArmored?: string;
  /** Alternative: fetch the key from Key Vault via SDK. */
  keyVaultUrl?: string;
  secretName?: string;
  /** Passphrase for the private key, if it has one, usually {{env.GPG_PASSPHRASE}}. */
  passphrase?: string;
  /** Alternative: fetch the passphrase from Key Vault via SDK (same keyVaultUrl as the key). */
  passphraseSecretName?: string;
  /** Defaults to inputPath's basename with a trailing .gpg/.asc stripped, or "<basename>.decrypted" if neither suffix is present. */
  outputFileName?: string;
}

export interface GpgDecryptConfig {
  files: FileEntryConfig[];
}

function gpg(gnupgHome: string, args: string[]): string {
  return execFileSync('gpg', ['--batch', '--yes', ...args], {
    env: { ...process.env, GNUPGHOME: gnupgHome },
    encoding: 'utf8',
  });
}

async function fetchSecretFromVault(keyVaultUrl: string, secretName: string, ctx: StepContext): Promise<string> {
  ctx.log(`Fetching secret "${secretName}" from ${keyVaultUrl} via SDK`);
  // Imported via variable specifiers so tsc doesn't require these optional
  // deps to be installed; they're only needed if this route is used.
  let identity: any;
  let secrets: any;
  try {
    const [identityPkg, secretsPkg] = ['@azure/identity', '@azure/keyvault-secrets'];
    identity = await import(identityPkg);
    secrets = await import(secretsPkg);
  } catch {
    throw new Error(
      'keyVaultUrl was set but @azure/identity / @azure/keyvault-secrets are not installed. ' +
      'Either `npm i @azure/identity @azure/keyvault-secrets`, or use the AzureKeyVault@2 ' +
      'task and pass the key via privateKeyArmored instead.',
    );
  }
  const client = new secrets.SecretClient(keyVaultUrl, new identity.DefaultAzureCredential());
  const secret = await client.getSecret(secretName);
  if (!secret.value) throw new Error(`Secret "${secretName}" has no value`);
  return secret.value;
}

// ---------- Per-file decryption --------------------------------------------

interface OneFileResult {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  sourceFile: string;
}

function defaultOutputFileName(inputName: string): string {
  if (inputName.endsWith('.gpg') || inputName.endsWith('.asc')) return inputName.slice(0, -4);
  return `${inputName}.decrypted`;
}

async function decryptOneFile(
  file: FileEntryConfig,
  ctx: StepContext,
  usedOutputNames: Set<string>,
): Promise<OneFileResult> {
  if (!file.inputPath) throw new Error('inputPath is required');
  if (!fs.existsSync(file.inputPath)) throw new Error(`Input file not found: ${file.inputPath}`);

  const inputName = path.basename(file.inputPath);
  const outputFileName = file.outputFileName ?? defaultOutputFileName(inputName);
  if (usedOutputNames.has(outputFileName)) {
    throw new Error(
      `Output filename "${outputFileName}" is already used by an earlier file entry in this batch. ` +
      'Set an explicit, distinct outputFileName for each entry.',
    );
  }
  usedOutputNames.add(outputFileName);

  // --- Resolve the private key -------------------------------------
  let privateKey = file.privateKeyArmored;
  if (!privateKey && file.keyVaultUrl && file.secretName) {
    privateKey = await fetchSecretFromVault(file.keyVaultUrl, file.secretName, ctx);
  }
  if (!privateKey || !privateKey.includes('BEGIN PGP PRIVATE KEY BLOCK')) {
    throw new Error(
      'No usable GPG private key. Provide privateKeyArmored (ASCII-armored) ' +
      'or keyVaultUrl + secretName. If the key arrived via a pipeline ' +
      'variable, check the secret was actually mapped into the step env.',
    );
  }
  // Restore newlines if the key was flattened to a single line with \n escapes.
  if (!privateKey.includes('\n')) privateKey = privateKey.replace(/\\n/g, '\n');

  // --- Resolve the passphrase (optional) ----------------------------
  let passphrase = file.passphrase;
  if (!passphrase && file.passphraseSecretName) {
    if (!file.keyVaultUrl) throw new Error('passphraseSecretName requires keyVaultUrl');
    passphrase = await fetchSecretFromVault(file.keyVaultUrl, file.passphraseSecretName, ctx);
  }

  // --- Import into an ephemeral keyring, scoped to this file entry ---
  const gnupgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gnupg-'));
  fs.chmodSync(gnupgHome, 0o700);
  try {
    const keyPath = path.join(gnupgHome, 'priv.asc');
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
    gpg(gnupgHome, ['--import', keyPath]);

    // --- Decrypt -----------------------------------------------------
    const outputPath = path.join(ctx.outDir, outputFileName);

    const args: string[] = [];
    if (passphrase) args.push('--pinentry-mode', 'loopback', '--passphrase', passphrase);
    args.push('--output', outputPath, '--decrypt', file.inputPath);
    gpg(gnupgHome, args);

    const stats = fs.statSync(outputPath);
    ctx.log(`Wrote ${outputPath} (${stats.size} bytes)`);

    return {
      fileName: outputFileName,
      filePath: outputPath,
      sizeBytes: stats.size,
      sourceFile: file.inputPath,
    };
  } finally {
    fs.rmSync(gnupgHome, { recursive: true, force: true });
  }
}

// ---------- Step ------------------------------------------------------------

export default defineStep<GpgDecryptConfig>({
  async run(config, ctx) {
    if (!config.files || config.files.length === 0) {
      throw new Error('config.files must contain at least one file');
    }

    const outputs: Record<string, string | number | boolean> = {
      totalFiles: config.files.length,
    };
    const artifacts: string[] = [];
    const usedOutputNames = new Set<string>();

    for (let index = 0; index < config.files.length; index++) {
      const file = config.files[index];
      const name = file.name ?? `f${index}`;
      let result: OneFileResult;
      try {
        result = await decryptOneFile(file, ctx, usedOutputNames);
      } catch (err) {
        throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
      }
      outputs[`${name}_decryptedPath`] = result.filePath;
      outputs[`${name}_fileName`] = result.fileName;
      outputs[`${name}_sizeBytes`] = result.sizeBytes;
      outputs[`${name}_sourceFile`] = result.sourceFile;
      artifacts.push(result.filePath);
    }

    return { outputs, artifacts };
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test "steps/gpg-decrypt-file.test.ts"`
Expected: PASS, 10/10 tests, output pristine (no stray gpg warnings beyond gpg's normal informational stderr lines, which `execFileSync` doesn't surface as test output unless a command fails).

- [ ] **Step 5: Commit**

```bash
git add steps/gpg-decrypt-file.ts steps/gpg-decrypt-file.test.ts
git commit -m "$(cat <<'EOF'
feat: add gpg-decrypt-file step

Mirrors gpg-encrypt-file's batch/key-delivery/ephemeral-keyring pattern
in reverse (private key + gpg --decrypt), with optional passphrase
support since private keys commonly need one.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Example config + pipeline wiring + verification gate

**Files:**
- Create: `configs/gpg-decrypt-result.json`
- Modify: `.pipelines/azure-pipelines.yml`

**Interfaces:**
- Consumes: Task 1's `GpgDecryptConfig` shape; `verify-and-download-blob`'s existing output key `result_localPath` (from `configs/verify-and-download-blob.json`'s file entry named `"result"` — confirmed by reading that config file directly, not assumed).

- [ ] **Step 1: Create the example config**

Create `configs/gpg-decrypt-result.json`:

```json
{
  "files": [
    {
      "name": "result",
      "inputPath": "{{steps.verifyResult.outputs.result_localPath}}",
      "privateKeyArmored": "{{env.GPG_PRIVATE_KEY}}",
      "passphrase": "{{env.GPG_PASSPHRASE}}"
    }
  ]
}
```

- [ ] **Step 2: Wire the step into the Deliver stage**

In `.pipelines/azure-pipelines.yml`, find the Deliver stage's `verifyResult` step (currently the first script step in that stage, right after `download: current`):

```yaml
          # ---- Step: verify + download the outbound result file -------
          # NOTE: azureClientId/azureClientSecret/azureTenantId are set via
          # task.setvariable in the Generate stage's AzureCLI@2 task (above);
          # pipeline variables set that way do NOT cross stage boundaries.
          # A real pipeline needs its own AzureCLI@2 task here in Deliver,
          # with addSpnToEnvironment: true, to re-export these for this step
          # — illustrative only, like the rest of this file's placeholders.
          - script: >
              npx tsx runner/run-step.ts
              --step steps/verify-and-download-blob.ts
              --config configs/verify-and-download-blob.json
              --name verifyResult
            name: verifyResult
            displayName: 'Verify and download outbound result'
            env:
              AZURE_CLIENT_ID: $(azureClientId)
              AZURE_CLIENT_SECRET: $(azureClientSecret)
              AZURE_TENANT_ID: $(azureTenantId)

          # ---- Step: verify the outbound result's row count -------------
```

Insert a new step immediately after `verifyResult` and before the row-count step, so the file that reaches every later Deliver step is the decrypted content, not the `.gpg` payload:

```yaml
          # ---- Step: verify + download the outbound result file -------
          # NOTE: azureClientId/azureClientSecret/azureTenantId are set via
          # task.setvariable in the Generate stage's AzureCLI@2 task (above);
          # pipeline variables set that way do NOT cross stage boundaries.
          # A real pipeline needs its own AzureCLI@2 task here in Deliver,
          # with addSpnToEnvironment: true, to re-export these for this step
          # — illustrative only, like the rest of this file's placeholders.
          - script: >
              npx tsx runner/run-step.ts
              --step steps/verify-and-download-blob.ts
              --config configs/verify-and-download-blob.json
              --name verifyResult
            name: verifyResult
            displayName: 'Verify and download outbound result'
            env:
              AZURE_CLIENT_ID: $(azureClientId)
              AZURE_CLIENT_SECRET: $(azureClientSecret)
              AZURE_TENANT_ID: $(azureTenantId)

          # ---- Fetch GPG private key + passphrase from Azure Key Vault --
          - task: AzureKeyVault@2
            displayName: 'Fetch GPG private key from Key Vault'
            inputs:
              azureSubscription: 'my-service-connection'
              KeyVaultName: 'my-keyvault'
              SecretsFilter: 'gpg-private-key,gpg-passphrase'
              RunAsPreJob: false

          # ---- Step: GPG-decrypt the downloaded outbound result --------
          - script: >
              npx tsx runner/run-step.ts
              --step steps/gpg-decrypt-file.ts
              --config configs/gpg-decrypt-result.json
              --name gpgDecryptResult
            name: gpgDecryptResult
            displayName: 'GPG decrypt outbound result with Key Vault key'
            env:
              GPG_PRIVATE_KEY: $(gpg-private-key)   # secrets are never auto-exposed to scripts
              GPG_PASSPHRASE: $(gpg-passphrase)

          # ---- Step: verify the outbound result's row count -------------
```

Note: `verify-row-count`/`validate-json-schema`/`validate-business-logic`'s own configs still point at `verifyResult`'s output path today — this plan does not rewire those (out of scope; the spec's "Out of scope" section doesn't cover this, but changing three unrelated configs' `inputPath`/equivalent references to point at `gpgDecryptResult`'s output instead is a separate, follow-up concern the user hasn't asked for here). This step is wired in and runnable; connecting its output as the new source of truth for the rest of the stage is left as-is, matching the same "illustrative placeholder" spirit already documented throughout this YAML file.

- [ ] **Step 3: Run the full verification gate**

Run, in order:

```bash
npm test
npm run typecheck
npm run lint
```

Expected: all three exit 0.

- [ ] **Step 4: Commit**

```bash
git add configs/gpg-decrypt-result.json .pipelines/azure-pipelines.yml
git commit -m "$(cat <<'EOF'
feat: wire gpg-decrypt-file into the Deliver stage

Adds an example config and pipeline step that decrypts the downloaded
outbound result immediately after verify-and-download-blob, using the
same AzureKeyVault@2 -> env var pattern the encrypt step already uses.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

## Self-Review Notes

- **Spec coverage:** every element of the spec has a task — the config schema, both key-delivery routes, passphrase resolution (both routes plus the `passphraseSecretName`-without-`keyVaultUrl` error), the ephemeral-keyring mechanism, the default-output-filename rule, outputs/artifacts shape, and the config example + pipeline wiring are all present (Task 1 for the step itself, Task 2 for the example/wiring).
- **Type consistency:** `FileEntryConfig`/`GpgDecryptConfig`/`OneFileResult` are defined once in Task 1 and used as-is; the test file's assertions (`fileA_fileName`, `fileA_decryptedPath`, etc.) match the exact output-key names the implementation produces (`${name}_decryptedPath`, `${name}_fileName`, `${name}_sizeBytes`, `${name}_sourceFile`).
- **Verified against real `gpg`, not assumed:** the controller ran the full keypair-generation / secret-key-export / encrypt / decrypt-with-passphrase / decrypt-without-passphrase-fails sequence directly against the real `gpg` binary in this environment before writing this plan, confirming every command in Task 1's implementation and test code works exactly as written (including that a missing passphrase produces a real `gpg` failure, not a hang or a false success).
- **No placeholders:** both tasks show complete file contents and exact YAML insertion points, not descriptions of what to write.
