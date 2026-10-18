import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const imageModule = require('../../src/nac/image');
const vectorModule = require('./vector');

const harnessDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(harnessDirectory, '../../../../..');
const stagedInput = path.resolve(
  harnessDirectory,
  '../../../../libpebble3/src/androidDeviceTest/assets/nac-parity/local-input.json',
);
const libpebbleBuildDirectory = path.resolve(harnessDirectory, '../../../../libpebble3/build');
const ANDROID_TEST_PACKAGE = 'io.rebble.libpebblecommon.test';
const MAX_VECTOR_FILE_BYTES = 8 * 1024 * 1024;

function fail(message) {
  const error = new Error(message);
  error.code = 'NAC_PARITY_STAGE_INVALID';
  throw error;
}

function readExplicitRegularFile(filePath, maximum, name) {
  if (typeof filePath !== 'string' || filePath.length === 0 || !path.isAbsolute(filePath)) {
    fail(`${name} must be an explicit absolute path`);
  }
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (_) { fail(`${name} is not readable`); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${name} must identify a regular non-symlink file`);
  if (stat.size < 1 || stat.size > maximum) fail(`${name} is outside its byte limit`);
  return fs.readFileSync(filePath);
}

function hash(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest('hex');
}

function decodeCanonical(value, name) {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) fail(`${name} is not canonical base64`);
  return decoded;
}

function verifyExpected(descriptor, name) {
  const decoded = decodeCanonical(descriptor.base64, name);
  if (decoded.length !== descriptor.length || hash('sha256', decoded) !== descriptor.sha256) {
    fail(`${name} length or SHA-256 does not match its bytes`);
  }
}

export function readAndVerifyVector(filePath) {
  const relative = typeof filePath === 'string' && path.isAbsolute(filePath)
    ? path.relative(repositoryRoot, filePath) : '';
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..') {
    fail('NAC_PARITY_VECTOR_FILE must stay outside the repository');
  }
  const encoded = readExplicitRegularFile(filePath, MAX_VECTOR_FILE_BYTES, 'NAC_PARITY_VECTOR_FILE');
  let vector;
  try { vector = JSON.parse(encoded.toString('utf8')); } catch (_) { fail('NAC parity vector is not JSON'); }
  vectorModule.validateVector(vector);
  verifyExpected(vector.expected.sessionInfoRequest, 'expected session-info request');
  verifyExpected(vector.expected.validationData, 'expected validation data');
  decodeCanonical(vector.certificateChainBase64, 'certificate chain');
  decodeCanonical(vector.sessionInfoBase64, 'session-info response');
  return vector;
}

export function readAndVerifyBinary(filePath) {
  const binary = readExplicitRegularFile(
    filePath, vectorModule.MAX_IMAGE_BYTES, 'NAC_BINARY_FILE'
  );
  if (hash('sha1', binary) !== vectorModule.IMAGE_SHA1
      || hash('sha256', binary) !== vectorModule.IMAGE_SHA256) {
    fail('NAC binary full-file hashes do not match the pins');
  }
  let slice;
  try { slice = imageModule.extractX86_64Slice(new Uint8Array(binary)); }
  catch (_) { fail('NAC binary does not contain the pinned x86-64 image'); }
  if (hash('sha256', slice) !== vectorModule.SLICE_SHA256) {
    fail('NAC binary x86-64 slice hash does not match the pin');
  }
  return binary;
}

export function buildStagedInput(binary, vector) {
  const input = {
    schemaVersion: vectorModule.SCHEMA_VERSION,
    imageBase64: binary.toString('base64'),
    vector,
  };
  vectorModule.validateLocalInput(input);
  return `${JSON.stringify(input)}\n`;
}

export function stage(binaryPath, vectorPath) {
  const binary = readAndVerifyBinary(binaryPath);
  const vector = readAndVerifyVector(vectorPath);
  const encoded = buildStagedInput(binary, vector);
  fs.mkdirSync(path.dirname(stagedInput), { recursive: true });
  const temporary = `${stagedInput}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, stagedInput);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function adbResult(serial, args) {
  return spawnSync('adb', ['-s', serial].concat(args), {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
}

function successfulAdbOutput(result) {
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    fail('Android emulator cleanup failed');
  }
  return result.stdout.trim();
}

export function cleanLocalParity(options = {}) {
  const serial = options.serial === undefined
    ? process.env.NAC_PARITY_ANDROID_SERIAL : options.serial;
  const removePath = options.removePath || ((target, recursive) => fs.rmSync(
    target, { recursive, force: true }
  ));
  const runAdb = options.runAdb || adbResult;
  const inputPath = options.inputPath || stagedInput;
  const buildDirectory = options.buildDirectory || libpebbleBuildDirectory;
  if (typeof serial !== 'string' || !/^emulator-[1-9][0-9]*$/.test(serial)) {
    fail('NAC_PARITY_ANDROID_SERIAL must identify an explicit Android emulator');
  }
  removePath(inputPath, false);
  // The local vector is packaged into Gradle intermediates and the instrumentation APK. Removing
  // the module's generated build tree is intentionally broad so no renamed Android output can
  // retain ExtractKey hardware or protocol bytes. Source files live outside this directory.
  removePath(buildDirectory, true);
  if (successfulAdbOutput(runAdb(serial, ['shell', 'getprop', 'ro.kernel.qemu'])) !== '1') {
    fail('NAC parity cleanup refuses to operate on a physical Android device');
  }
  const installed = successfulAdbOutput(runAdb(
    serial, ['shell', 'pm', 'list', 'packages', ANDROID_TEST_PACKAGE]
  ));
  if (installed === '') return;
  if (installed !== `package:${ANDROID_TEST_PACKAGE}`) {
    fail('Android emulator package inventory was malformed');
  }
  if (successfulAdbOutput(runAdb(serial, ['uninstall', ANDROID_TEST_PACKAGE])) !== 'Success') {
    fail('Android emulator test package cleanup failed');
  }
}

function main(argv) {
  const command = argv[2];
  if (command === 'clean') {
    cleanLocalParity();
    process.stdout.write('Removed the local parity input, generated test artifacts, and emulator test package.\n');
    return;
  }
  if (command !== 'check' && command !== 'stage') {
    fail('usage: node stage.mjs check|stage|clean');
  }
  const binaryPath = process.env.NAC_BINARY_FILE;
  const vectorPath = process.env.NAC_PARITY_VECTOR_FILE;
  if (command === 'check') {
    readAndVerifyBinary(binaryPath);
    readAndVerifyVector(vectorPath);
    process.stdout.write('Local Android NAC parity inputs are valid.\n');
  } else {
    stage(binaryPath, vectorPath);
    process.stdout.write('Staged the local Android NAC parity input.\n');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(process.argv); }
  catch (error) {
    process.stderr.write(`${error.code || 'NAC_PARITY_STAGE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
