import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import step from './gpg-encrypt-file';
import type { StepContext } from '../runner/types';

let testGnupgHome: string;
let publicKeyA: string;
let publicKeyB: string;

function genTestKey(gnupgHome: string, uid: string): string {
  execFileSync(
    'gpg',
    ['--batch', '--passphrase', '', '--quick-gen-key', uid, 'default', 'default', 'never'],
    { env: { ...process.env, GNUPGHOME: gnupgHome } },
  );
  return execFileSync('gpg', ['--armor', '--export', uid], {
    env: { ...process.env, GNUPGHOME: gnupgHome },
    encoding: 'utf8',
  });
}

function decryptWithTestKey(encryptedPath: string): string {
  return execFileSync(
    'gpg',
    ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', '', '--decrypt', encryptedPath],
    { env: { ...process.env, GNUPGHOME: testGnupgHome }, encoding: 'utf8' },
  );
}

function fakeCtx(outDir: string): StepContext {
  return {
    stepName: 'test',
    outDir,
    workspace: outDir,
    steps: {},
    log: () => {},
    warn: () => {},
  };
}

before(() => {
  testGnupgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gnupg-test-'));
  fs.chmodSync(testGnupgHome, 0o700);
  publicKeyA = genTestKey(testGnupgHome, 'Test A <a@example.com>');
  publicKeyB = genTestKey(testGnupgHome, 'Test B <b@example.com>');
});

after(() => {
  fs.rmSync(testGnupgHome, { recursive: true, force: true });
});

test('encrypts a single named file and round-trips through decrypt', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
  try {
    const inputPath = path.join(outDir, 'input.txt');
    fs.writeFileSync(inputPath, 'hello from file A\n');
    const config = {
      files: [{ name: 'fileA', inputPath, publicKeyArmored: publicKeyA, outputFileName: 'a.gpg' }],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.totalFiles, 1);
    assert.equal(result.outputs?.fileA_fileName, 'a.gpg');
    const encryptedPath = result.outputs?.fileA_encryptedPath as string;
    assert.ok(fs.existsSync(encryptedPath));
    assert.equal(decryptWithTestKey(encryptedPath), 'hello from file A\n');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('encrypts multiple files with different keys and distinct output names', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
  try {
    const inputA = path.join(outDir, 'a.txt');
    const inputB = path.join(outDir, 'b.txt');
    fs.writeFileSync(inputA, 'payload A\n');
    fs.writeFileSync(inputB, 'payload B\n');
    const config = {
      files: [
        { name: 'outA', inputPath: inputA, publicKeyArmored: publicKeyA, outputFileName: 'a.gpg' },
        { name: 'outB', inputPath: inputB, publicKeyArmored: publicKeyB, outputFileName: 'b.gpg' },
      ],
    };
    const result = await step.run(config, fakeCtx(outDir));
    assert.equal(result.outputs?.totalFiles, 2);
    assert.notEqual(result.outputs?.outA_encryptedPath, result.outputs?.outB_encryptedPath);
    assert.equal(decryptWithTestKey(result.outputs?.outA_encryptedPath as string), 'payload A\n');
    assert.equal(decryptWithTestKey(result.outputs?.outB_encryptedPath as string), 'payload B\n');
    assert.notEqual(result.outputs?.outA_recipient, result.outputs?.outB_recipient);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('throws when two entries default or specify the same output filename', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
  try {
    const inputA = path.join(outDir, 'a.txt');
    const inputB = path.join(outDir, 'b.txt');
    fs.writeFileSync(inputA, 'payload A\n');
    fs.writeFileSync(inputB, 'payload B\n');
    const config = {
      files: [
        { name: 'outA', inputPath: inputA, publicKeyArmored: publicKeyA, outputFileName: 'same.gpg' },
        { name: 'outB', inputPath: inputB, publicKeyArmored: publicKeyB, outputFileName: 'same.gpg' },
      ],
    };
    await assert.rejects(
      async () => step.run(config, fakeCtx(outDir)),
      /File entry 1 \("outB"\) failed:.*same\.gpg.*already used/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('fails fast when an input file is missing, naming the entry', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
  try {
    const config = {
      files: [{ name: 'missing', inputPath: path.join(outDir, 'nope.txt'), publicKeyArmored: publicKeyA }],
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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpg-test-'));
  try {
    await assert.rejects(
      async () => step.run({ files: [] }, fakeCtx(outDir)),
      /config\.files must contain at least one file/,
    );
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
