/**
 * Step: gpg-encrypt-file (TypeScript)
 *
 * Encrypts a file with a GPG public key sourced from Azure Key Vault.
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

export interface GpgEncryptConfig {
  /** File to encrypt, usually {{steps.<name>.outputs.csvPath}}. */
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
  /* eslint-disable @typescript-eslint/no-explicit-any */
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

export default defineStep<GpgEncryptConfig>({
  async run(config, ctx) {
    if (!config.inputPath) throw new Error('config.inputPath is required');
    if (!fs.existsSync(config.inputPath)) throw new Error(`Input file not found: ${config.inputPath}`);

    // --- Resolve the public key -------------------------------------
    let publicKey = config.publicKeyArmored;
    if (!publicKey && config.keyVaultUrl && config.secretName) {
      publicKey = await fetchKeyFromVault(config.keyVaultUrl, config.secretName, ctx);
    }
    if (!publicKey || !publicKey.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
      throw new Error(
        'No usable GPG public key. Provide config.publicKeyArmored (ASCII-armored) ' +
        'or config.keyVaultUrl + config.secretName. If the key arrived via a pipeline ' +
        'variable, check the secret was actually mapped into the step env.',
      );
    }
    // Restore newlines if the key was flattened to a single line with \n escapes.
    if (!publicKey.includes('\n')) publicKey = publicKey.replace(/\\n/g, '\n');

    // --- Import into an ephemeral keyring ---------------------------
    const gnupgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gnupg-'));
    fs.chmodSync(gnupgHome, 0o700);
    try {
      const keyPath = path.join(gnupgHome, 'pub.asc');
      fs.writeFileSync(keyPath, publicKey, { mode: 0o600 });
      gpg(gnupgHome, ['--import', keyPath]);

      let recipient = config.recipient;
      if (!recipient) {
        const listing = gpg(gnupgHome, ['--list-keys', '--with-colons']);
        const fprLine = listing.split('\n').find(l => l.startsWith('fpr:'));
        if (!fprLine) throw new Error('Could not determine fingerprint of imported key');
        recipient = fprLine.split(':')[9];
      }
      ctx.log(`Encrypting for recipient ${recipient}`);

      // --- Encrypt ---------------------------------------------------
      const inputName = path.basename(config.inputPath);
      const outputFileName =
        config.outputFileName ?? `${inputName}${config.armor ? '.asc' : '.gpg'}`;
      const outputPath = path.join(ctx.outDir, outputFileName);

      const args = [
        '--trust-model', 'always', // ephemeral keyring; key provenance is Key Vault
        '--recipient', recipient,
        '--output', outputPath,
      ];
      if (config.armor) args.push('--armor');
      if (config.cipherAlgo) args.push('--cipher-algo', config.cipherAlgo);
      args.push('--encrypt', config.inputPath);
      gpg(gnupgHome, args);

      const stats = fs.statSync(outputPath);
      ctx.log(`Wrote ${outputPath} (${stats.size} bytes)`);

      return {
        outputs: {
          encryptedPath: outputPath,
          fileName: outputFileName,
          recipient,
          sizeBytes: stats.size,
          sourceFile: config.inputPath,
        },
        artifacts: [outputPath],
      };
    } finally {
      fs.rmSync(gnupgHome, { recursive: true, force: true });
    }
  },
});
