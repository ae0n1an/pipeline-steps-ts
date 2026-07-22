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
    await assert.rejects(async () => step.run(config, fakeCtx(outDir)), /File entry 0 \("fileC"\) failed:[\s\S]*decryption failed/i);
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

test('appends .decrypted when the input has no .gpg or .asc suffix', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-decrypt-out-'));
  try {
    const encBin = path.join(outDir, 'payload.bin');
    encryptForTest(UID_NO_PASS, 'binary payload\n', encBin);
    const config = { files: [{ name: 'p', inputPath: encBin, privateKeyArmored: keyNoPass.privateKey }] };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.p_fileName, 'payload.bin.decrypted');
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
