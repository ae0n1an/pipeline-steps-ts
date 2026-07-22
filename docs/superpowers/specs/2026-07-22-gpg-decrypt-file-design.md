# gpg-decrypt-file — Design

## Purpose

The pipeline's Deliver stage downloads a GPG-encrypted result file
(`verify-and-download-blob`) but has no step to decrypt it. This adds
`gpg-decrypt-file`, the inverse of the existing `gpg-encrypt-file`: same
batch-of-files shape, same two key-delivery routes, same ephemeral-keyring
mechanism, but importing a private key and running `gpg --decrypt`.

## Config

```ts
export interface FileEntryConfig {
  /** Output key prefix for this file's results; defaults to "f{index}". */
  name?: string;
  /** Encrypted file to decrypt, usually {{steps.verifyResult.outputs.f0_localPath}}. */
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
```

## Mechanism

Per file, mirroring `gpg-encrypt-file.ts`'s `encryptOneFile`:

1. Validate `inputPath` exists; validate the resolved `outputFileName` isn't
   already used by an earlier entry in this batch (same two errors,
   same wording, as encrypt's `Input file not found` /
   `already used by an earlier file entry`).
2. Resolve the private key: `privateKeyArmored` if set, else
   `fetchSecretFromVault(keyVaultUrl, secretName, ctx)`. Validate it
   contains `BEGIN PGP PRIVATE KEY BLOCK`; restore newlines if the key
   arrived flattened (`\n` → literal newline), same as encrypt does for
   the public key. Error message: `No usable GPG private key. Provide
   privateKeyArmored (ASCII-armored) or keyVaultUrl + secretName. ...`
   (same shape as encrypt's public-key error, private-key wording).
3. Resolve the passphrase (optional): `passphrase` if set, else, if
   `passphraseSecretName` is set, `fetchSecretFromVault(keyVaultUrl,
   passphraseSecretName, ctx)`. `passphraseSecretName` without
   `keyVaultUrl` throws immediately: `passphraseSecretName requires
   keyVaultUrl`. No passphrase configured at all means no passphrase is
   passed to gpg — if the key actually needs one, gpg itself fails with
   its own error, which surfaces as this file's entry-level error same as
   any other gpg failure.
4. Ephemeral `GNUPGHOME` (`fs.mkdtempSync` + `chmod 700`), imported via
   `gpg --import`, removed in a `finally` — identical to encrypt.
5. Decrypt: `gpg --batch --yes [--pinentry-mode loopback --passphrase
   <value>] --output <outputPath> --decrypt <inputPath>`. The
   `--pinentry-mode loopback` flag is only added when a passphrase
   resolved (required for gpg to accept `--passphrase` non-interactively;
   omitting it when there's no passphrase avoids an unnecessary flag on
   the common passphrase-less-automation-key path).
6. `fs.statSync` the output file for `sizeBytes`, same as encrypt.

`fetchSecretFromVault(keyVaultUrl, secretName, ctx)`: a generic version of
encrypt's `fetchKeyFromVault`, taking the secret name as a parameter so it
serves both the private key and, when configured, the passphrase. Same
lazy-`import()` of `@azure/identity`/`@azure/keyvault-secrets` with the
same "not installed" guidance error. Duplicated locally rather than
extracted to `steps/lib/`, matching this repo's per-step self-containment
convention (see `extract-adf-run-details.ts`'s doc comment on the same
tradeoff) — the only two callers are this file's own key and passphrase
resolution.

## Outputs

Per file: `${name}_decryptedPath`, `${name}_fileName`, `${name}_sizeBytes`,
`${name}_sourceFile`. Top-level: `totalFiles`. (No `recipient` output —
that's an encrypt-only concept; decrypt doesn't choose a recipient.)
Artifacts: every decrypted file path, matching encrypt's `artifacts`
convention.

Per-file errors wrapped identically to encrypt: `File entry <index>
("<name>") failed: <message>`. Matching encrypt's existing loop exactly,
this is fail-fast, not aggregate-then-report: the first entry that throws
stops the batch immediately, and any later entries in `files` are never
attempted (not a design change from encrypt — just consistency; a
future request to make either step aggregate-and-continue like
`verify-and-download-blob` does would apply to both equally).

## Testing

Mirrors `gpg-encrypt-file.test.ts`'s approach: real ephemeral GPG keypairs
generated in a `before()` hook via `--quick-gen-key` (one passphrase-less,
one with `--passphrase <value>`), a known payload encrypted with each
public half using real `gpg` directly (not through the step), then the
step decrypts it and the test asserts the round-tripped plaintext matches
exactly. Plus: multiple files in one batch with different keys: duplicate
output filename error; missing input file error; empty `files` error; a
passphrase-protected key decrypted correctly when `passphrase` is set;
and the same key failing (real gpg error, not a crash) when no passphrase
is supplied and one was required.

## Config example + pipeline wiring

`configs/gpg-decrypt-result.json`:

```json
{
  "files": [
    {
      "name": "resultGpg",
      "inputPath": "{{steps.verifyResult.outputs.f0_localPath}}",
      "privateKeyArmored": "{{env.GPG_PRIVATE_KEY}}",
      "passphrase": "{{env.GPG_PASSPHRASE}}"
    }
  ]
}
```

Wired into `.pipelines/azure-pipelines.yml`'s Deliver stage, directly after
the existing `verifyResult` step, following the same
`AzureKeyVault@2` → env var pattern the Generate stage already uses for
the encrypt step's public key (illustrative placeholder service
connection/vault names, matching the rest of this file's style).

## Out of scope

- No support for multiple recipients/keys per file (matches encrypt,
  which is also single-key-per-file).
- No symmetric (passphrase-only, no keypair) decryption — this step
  always imports a keypair; a symmetric-only use case isn't part of this
  pipeline's design.
- No change to `gpg-encrypt-file.ts` itself.
