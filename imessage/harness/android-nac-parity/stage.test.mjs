import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { cleanLocalParity, readAndVerifyBinary, readAndVerifyVector } from './stage.mjs';

const require = createRequire(import.meta.url);
const vectorModule = require('./vector');

function digest(byte) {
  return crypto.createHash('sha256').update(Buffer.from([byte])).digest('hex');
}

function validVector() {
  return {
    schemaVersion: 1,
    id: 'synthetic-offline-1',
    oracle: {
      cortenCommit: vectorModule.CORTEN_COMMIT,
      nacBinarySha1: vectorModule.IMAGE_SHA1,
      nacBinarySha256: vectorModule.IMAGE_SHA256,
      nacX86_64SliceSha256: vectorModule.SLICE_SHA256,
    },
    hardware: JSON.parse(JSON.stringify(vectorModule.SYNTHETIC_HARDWARE)),
    arc4randomWords: [1, 4294967295],
    certificateChainBase64: 'AQ==',
    sessionInfoBase64: 'Ag==',
    expected: {
      sessionInfoRequest: { base64: 'Aw==', length: 1, sha256: digest(3) },
      validationData: { base64: 'BA==', length: 1, sha256: digest(4) },
    },
  };
}

function withTempDirectory(block) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nac-parity-test-'));
  try { return block(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('accepts a strictly shaped local hardware vector with matching output digests', () => {
  withTempDirectory((directory) => {
    const file = path.join(directory, 'vector.json');
    fs.writeFileSync(file, JSON.stringify(validVector()));
    assert.equal(readAndVerifyVector(file).id, 'synthetic-offline-1');
  });
});

test('rejects unexpected credential-shaped fields', () => {
  const vector = validVector();
  vector.appleId = 'not-accepted';
  assert.throws(() => vectorModule.validateVector(vector), /unexpected or missing field/);
});

test('rejects malformed local hardware fields', () => {
  const vector = validVector();
  vector.hardware.platformSerialNumberEnc = [1, 2, 3];
  assert.throws(() => vectorModule.validateVector(vector), /exactly 17 bytes/);
});

test('rejects noncanonical protocol base64', () => {
  const vector = validVector();
  vector.sessionInfoBase64 = 'Ag';
  assert.throws(() => vectorModule.validateVector(vector), /canonical padded base64/);
});

test('rejects an expected-output digest mismatch', () => {
  withTempDirectory((directory) => {
    const vector = validVector();
    vector.expected.validationData.sha256 = '0'.repeat(64);
    const file = path.join(directory, 'vector.json');
    fs.writeFileSync(file, JSON.stringify(vector));
    assert.throws(() => readAndVerifyVector(file), /length or SHA-256/);
  });
});

test('rejects a binary symlink before reading or hashing it', () => {
  withTempDirectory((directory) => {
    const target = path.join(directory, 'target');
    const link = path.join(directory, 'binary');
    fs.writeFileSync(target, 'not the binary');
    fs.symlinkSync(target, link);
    assert.throws(() => readAndVerifyBinary(link), /regular non-symlink file/);
  });
});

test('rejects a regular file whose full hashes do not match', () => {
  withTempDirectory((directory) => {
    const file = path.join(directory, 'binary');
    fs.writeFileSync(file, Buffer.alloc(32));
    assert.throws(() => readAndVerifyBinary(file), /full-file hashes/);
  });
});

function adbResult(status, stdout = '') {
  return { status, stdout, error: null };
}

function cleanupScenario(responses) {
  const calls = [];
  const removed = [];
  const result = () => cleanLocalParity({
    serial: 'emulator-5554',
    inputPath: '/private/local-input.json',
    buildDirectory: '/private/libpebble3-build',
    removePath(target, recursive) { removed.push([target, recursive]); },
    runAdb(serial, args) {
      calls.push([serial, args]);
      return responses.shift();
    },
  });
  return { calls, removed, result };
}

test('cleanup removes host copies and uninstalls an installed emulator package', () => {
  const scenario = cleanupScenario([
    adbResult(0, '1\n'),
    adbResult(0, 'package:io.rebble.libpebblecommon.test\n'),
    adbResult(0, 'Success\n'),
  ]);
  scenario.result();
  assert.deepEqual(scenario.removed, [
    ['/private/local-input.json', false], ['/private/libpebble3-build', true],
  ]);
  assert.equal(scenario.calls.length, 3);
});

test('cleanup accepts an already absent emulator package', () => {
  const scenario = cleanupScenario([adbResult(0, '1\n'), adbResult(0, '')]);
  scenario.result();
  assert.equal(scenario.calls.length, 2);
  assert.equal(scenario.removed.length, 2);
});

test('cleanup refuses a non-emulator before attempting package removal', () => {
  const scenario = cleanupScenario([adbResult(0, '0\n')]);
  assert.throws(scenario.result, /physical Android device/);
  assert.equal(scenario.calls.length, 1);
  assert.equal(scenario.removed.length, 2);
});

test('cleanup reports uninstall failure after host copies are removed', () => {
  const scenario = cleanupScenario([
    adbResult(0, '1\n'),
    adbResult(0, 'package:io.rebble.libpebblecommon.test\n'),
    adbResult(1, ''),
  ]);
  assert.throws(scenario.result, /Android emulator cleanup failed/);
  assert.equal(scenario.removed.length, 2);
});
