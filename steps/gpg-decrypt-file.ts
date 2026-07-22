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
