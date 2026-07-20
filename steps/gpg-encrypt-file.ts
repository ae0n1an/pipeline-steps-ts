/**
 * Step: gpg-encrypt-file (TypeScript)
 *
 * Encrypts one or more files, each with its own GPG public key, sourced
 * from Azure Key Vault.
 * Route A (recommended): AzureKeyVault@2 task -> pipeline variable ->
 *   env mapping -> "publicKeyArmored": "{{env.GPG_PUBLIC_KEY}}"
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
  /** File to encrypt, usually {{steps.<name>.outputs.<key>_csvPath}}. */
  inputPath: string;
  /** ASCII-armored public key, usually {{env.GPG_PUBLIC_KEY}}. */
  publicKeyArmored?: string;
  /** Alternative: fetch the key from Key Vault via SDK. */
  keyVaultUrl?: string;
  secretName?: string;
  /** Recipient override; defaults to the imported key's fingerprint. */
  recipient?: string;
  outputFileName?: string;
  /** ASCII-armored output (.asc) instead of binary (.gpg). */
  armor?: boolean;
  /** e.g. "AES256" */
  cipherAlgo?: string;
}

export interface GpgEncryptConfig {
  files: FileEntryConfig[];
}

function gpg(gnupgHome: string, args: string[]): string {
  return execFileSync('gpg', ['--batch', '--yes', ...args], {
    env: { ...process.env, GNUPGHOME: gnupgHome },
    encoding: 'utf8',
  });
}

async function fetchKeyFromVault(keyVaultUrl: string, secretName: string, ctx: StepContext): Promise<string> {
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
      'task and pass the key via publicKeyArmored instead.',
    );
  }
  const client = new secrets.SecretClient(keyVaultUrl, new identity.DefaultAzureCredential());
  const secret = await client.getSecret(secretName);
  if (!secret.value) throw new Error(`Secret "${secretName}" has no value`);
  return secret.value;
}

// ---------- Per-file encryption --------------------------------------------

interface OneFileResult {
  fileName: string;
  filePath: string;
  recipient: string;
  sizeBytes: number;
  sourceFile: string;
}

async function encryptOneFile(
  file: FileEntryConfig,
  ctx: StepContext,
  usedOutputNames: Set<string>,
): Promise<OneFileResult> {
  if (!file.inputPath) throw new Error('inputPath is required');
  if (!fs.existsSync(file.inputPath)) throw new Error(`Input file not found: ${file.inputPath}`);

  const inputName = path.basename(file.inputPath);
  const outputFileName = file.outputFileName ?? `${inputName}${file.armor ? '.asc' : '.gpg'}`;
  if (usedOutputNames.has(outputFileName)) {
    throw new Error(
      `Output filename "${outputFileName}" is already used by an earlier file entry in this batch. ` +
      'Set an explicit, distinct outputFileName for each entry.',
    );
  }
  usedOutputNames.add(outputFileName);

  // --- Resolve the public key -------------------------------------
  let publicKey = file.publicKeyArmored;
  if (!publicKey && file.keyVaultUrl && file.secretName) {
    publicKey = await fetchKeyFromVault(file.keyVaultUrl, file.secretName, ctx);
  }
  if (!publicKey || !publicKey.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
    throw new Error(
      'No usable GPG public key. Provide publicKeyArmored (ASCII-armored) ' +
      'or keyVaultUrl + secretName. If the key arrived via a pipeline ' +
      'variable, check the secret was actually mapped into the step env.',
    );
  }
  // Restore newlines if the key was flattened to a single line with \n escapes.
  if (!publicKey.includes('\n')) publicKey = publicKey.replace(/\\n/g, '\n');

  // --- Import into an ephemeral keyring, scoped to this file entry ---
  const gnupgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gnupg-'));
  fs.chmodSync(gnupgHome, 0o700);
  try {
    const keyPath = path.join(gnupgHome, 'pub.asc');
    fs.writeFileSync(keyPath, publicKey, { mode: 0o600 });
    gpg(gnupgHome, ['--import', keyPath]);

    let recipient = file.recipient;
    if (!recipient) {
      const listing = gpg(gnupgHome, ['--list-keys', '--with-colons']);
      const fprLine = listing.split('\n').find(l => l.startsWith('fpr:'));
      if (!fprLine) throw new Error('Could not determine fingerprint of imported key');
      recipient = fprLine.split(':')[9];
    }
    ctx.log(`Encrypting for recipient ${recipient}`);

    // --- Encrypt ---------------------------------------------------
    const outputPath = path.join(ctx.outDir, outputFileName);

    const args = [
      '--trust-model', 'always', // ephemeral keyring; key provenance is Key Vault
      '--recipient', recipient,
      '--output', outputPath,
    ];
    if (file.armor) args.push('--armor');
    if (file.cipherAlgo) args.push('--cipher-algo', file.cipherAlgo);
    args.push('--encrypt', file.inputPath);
    gpg(gnupgHome, args);

    const stats = fs.statSync(outputPath);
    ctx.log(`Wrote ${outputPath} (${stats.size} bytes)`);

    return {
      fileName: outputFileName,
      filePath: outputPath,
      recipient,
      sizeBytes: stats.size,
      sourceFile: file.inputPath,
    };
  } finally {
    fs.rmSync(gnupgHome, { recursive: true, force: true });
  }
}

// ---------- Step ------------------------------------------------------------

export default defineStep<GpgEncryptConfig>({
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
        result = await encryptOneFile(file, ctx, usedOutputNames);
      } catch (err) {
        throw new Error(`File entry ${index} ("${name}") failed: ${(err as Error).message}`);
      }
      outputs[`${name}_encryptedPath`] = result.filePath;
      outputs[`${name}_fileName`] = result.fileName;
      outputs[`${name}_recipient`] = result.recipient;
      outputs[`${name}_sizeBytes`] = result.sizeBytes;
      outputs[`${name}_sourceFile`] = result.sourceFile;
      artifacts.push(result.filePath);
    }

    return { outputs, artifacts };
  },
});
