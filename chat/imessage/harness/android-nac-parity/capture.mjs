import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readAndVerifyBinary } from './stage.mjs';

const require = createRequire(import.meta.url);
const apsBag = require('../../src/aps/bag');
const binaryPlist = require('../../src/codecs/binary-plist');
const xmlPlist = require('../../src/codecs/xml-plist');
const idsBag = require('../../src/ids/bag');
const validationData = require('../../src/nac/validation-data');
const macAuthToken = require('../../src/configuration/mac-auth-token');
const vectorModule = require('./vector');

const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const MAX_ORACLE_LINE_BYTES = 4 * 1024 * 1024;
const MAX_RANDOM_WORDS = 4096;
const HTTP_TIMEOUT_MS = 30_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameBytes(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function canonicalBase64(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
      || !BASE64_PATTERN.test(value)) fail('NAC_CAPTURE_ORACLE_INVALID', `${name} is malformed`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < 1 || decoded.length > MAX_PROTOCOL_BYTES
      || decoded.toString('base64') !== value) {
    fail('NAC_CAPTURE_ORACLE_INVALID', `${name} is outside its bounds`);
  }
  return decoded;
}

function parsePlistData(body, field, name) {
  if (!(body instanceof Uint8Array) || body.length < 1 || body.length > MAX_HTTP_BODY_BYTES) {
    fail('NAC_CAPTURE_PROTOCOL_INVALID', `${name} response is outside its bounds`);
  }
  let root;
  try {
    const binary = body.length >= 8
      && Buffer.from(body.subarray(0, 8)).toString('ascii') === 'bplist00';
    root = binary
      ? binaryPlist.decodeBinaryPlist(body, { maxInputBytes: MAX_HTTP_BODY_BYTES })
      : xmlPlist.decodeXmlPlist(body, { maxInputBytes: MAX_HTTP_BODY_BYTES });
  } catch (_) {
    fail('NAC_CAPTURE_PROTOCOL_INVALID', `${name} response is not a property list`);
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)
      || !(root[field] instanceof Uint8Array) || root[field].length < 1
      || root[field].length > MAX_PROTOCOL_BYTES) {
    fail('NAC_CAPTURE_PROTOCOL_INVALID', `${name} response is missing ${field}`);
  }
  return new Uint8Array(root[field]);
}

function jsonHardware(value) {
  const result = {
    productName: value.productName,
    ioMacAddress: Array.from(value.ioMacAddress),
    platformSerialNumber: value.platformSerialNumber,
    platformUuid: value.platformUuid,
    rootDiskUuid: value.rootDiskUuid,
    boardId: value.boardId,
    osBuildNum: value.osBuildNum,
    platformSerialNumberEnc: Array.from(value.platformSerialNumberEnc),
    platformUuidEnc: Array.from(value.platformUuidEnc),
    rootDiskUuidEnc: Array.from(value.rootDiskUuidEnc),
    rom: Array.from(value.rom),
    romEnc: Array.from(value.romEnc),
    mlb: value.mlb,
    mlbEnc: Array.from(value.mlbEnc),
  };
  vectorModule.validateHardware(result);
  return result;
}

function snakeHardware(value) {
  return {
    product_name: value.productName,
    io_mac_address: value.ioMacAddress,
    platform_serial_number: value.platformSerialNumber,
    platform_uuid: value.platformUuid,
    root_disk_uuid: value.rootDiskUuid,
    board_id: value.boardId,
    os_build_num: value.osBuildNum,
    platform_serial_number_enc: value.platformSerialNumberEnc,
    platform_uuid_enc: value.platformUuidEnc,
    root_disk_uuid_enc: value.rootDiskUuidEnc,
    rom: value.rom,
    rom_enc: value.romEnc,
    mlb: value.mlb,
    mlb_enc: value.mlbEnc,
  };
}

export function deterministicRandomWords(count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_RANDOM_WORDS) {
    fail('NAC_CAPTURE_RANDOM_INVALID', 'random-word count is outside its bounds');
  }
  const words = [];
  for (let index = 0; index < count; index += 1) {
    words.push(Number((0x6d2b79f5n + BigInt(index) * 0x9e3779b9n) & 0xffffffffn));
  }
  return words;
}

function requireHttpResponse(response, stage) {
  if (!response || !Number.isSafeInteger(response.status)
      || !(response.body instanceof Uint8Array) || response.body.length > MAX_HTTP_BODY_BYTES) {
    fail('NAC_CAPTURE_HTTP_INVALID', `${stage} returned a malformed response`);
  }
  if (response.status < 200 || response.status >= 300) {
    fail('NAC_CAPTURE_HTTP_REJECTED', `${stage} was rejected with status ${response.status}`);
  }
  return response.body;
}

function requireOracleSuccess(response, operation) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    fail('NAC_CAPTURE_ORACLE_INVALID', `${operation} returned a malformed response`);
  }
  if (response.ok === true && response.result && typeof response.result === 'object') {
    return response.result;
  }
  const code = response.error && typeof response.error.code === 'string'
    ? response.error.code : 'unknown_oracle_error';
  const error = new Error(`${operation} failed (${code})`);
  error.code = code;
  throw error;
}

function isRandomMismatch(error) {
  return error && error.code === 'deterministic_random_mismatch';
}

function initializeRequest(requestId, certificate, hardware, words) {
  return {
    schema_version: 1,
    request_id: requestId,
    operation: 'initialize_nac_validation',
    cert_chain_base64: Buffer.from(certificate).toString('base64'),
    hardware: snakeHardware(hardware),
    arc4random_words: words,
    replace_pending: false,
  };
}

function completeRequest(requestId, sessionId, sessionInfo) {
  return {
    schema_version: 1,
    request_id: requestId,
    operation: 'complete_nac_validation',
    session_id: sessionId,
    session_info_base64: Buffer.from(sessionInfo).toString('base64'),
  };
}

function cancelRequest(requestId, sessionId) {
  return {
    schema_version: 1,
    request_id: requestId,
    operation: 'cancel_nac_validation',
    session_id: sessionId,
  };
}

async function initializeAt(oracle, certificate, hardware, count, requestId) {
  const words = deterministicRandomWords(count);
  const response = await oracle.request(initializeRequest(
    requestId, certificate, hardware, words
  ));
  const result = requireOracleSuccess(response, 'NAC initialization');
  if (typeof result.session_id !== 'string' || !/^[0-9a-f]{64}$/.test(result.session_id)) {
    fail('NAC_CAPTURE_ORACLE_INVALID', 'NAC initialization returned an invalid session ID');
  }
  return {
    count,
    words,
    sessionId: result.session_id,
    sessionRequest: canonicalBase64(
      result.session_info_request_base64, 'NAC session-info request'
    ),
  };
}

async function firstSuccessfulInitialization(oracle, certificate, hardware) {
  for (let count = 0; count <= MAX_RANDOM_WORDS; count += 1) {
    try {
      return await initializeAt(oracle, certificate, hardware, count, `initialize-${count}`);
    } catch (error) {
      if (!isRandomMismatch(error)) throw error;
    }
  }
  fail('NAC_CAPTURE_RANDOM_EXHAUSTED', 'NAC initialization exceeded the random-word limit');
}

async function safeCancel(oracle, pending) {
  if (!pending) return;
  try { await oracle.request(cancelRequest('capture-cleanup', pending.sessionId)); } catch (_) { /* best effort */ }
}

async function completeAt(oracle, pending, sessionInfo, requestId) {
  const response = await oracle.request(completeRequest(requestId, pending.sessionId, sessionInfo));
  return requireOracleSuccess(response, 'NAC completion');
}

function verifyCompletion(result, expectedCount) {
  const validation = canonicalBase64(result.validation_data_base64, 'NAC validation data');
  if (result.arc4random_words_consumed !== expectedCount
      || result.corten_commit !== vectorModule.CORTEN_COMMIT
      || result.nac_binary_sha1 !== vectorModule.IMAGE_SHA1
      || result.nac_binary_sha256 !== vectorModule.IMAGE_SHA256
      || result.nac_x86_64_slice_sha256 !== vectorModule.SLICE_SHA256) {
    fail('NAC_CAPTURE_ORACLE_INVALID', 'NAC completion provenance does not match the harness');
  }
  return validation;
}

export async function capturePublicVector({ oracle, httpRequest, hardware }) {
  if (!oracle || typeof oracle.request !== 'function' || typeof httpRequest !== 'function') {
    throw new TypeError('capture requires oracle and HTTP request adapters');
  }
  const localHardware = jsonHardware(hardware);
  let pending = null;
  try {
    const endpoints = await idsBag.fetchIdsEndpoints({ http: { request: httpRequest } });
    const certificateResponse = await httpRequest(validationData.buildCertificateRequest(
      endpoints.validationCertificateEndpoint
    ));
    const certificate = parsePlistData(
      requireHttpResponse(certificateResponse, 'certificate request'), 'cert', 'certificate'
    );

    pending = await firstSuccessfulInitialization(oracle, certificate, localHardware);
    const firstRequest = Buffer.from(pending.sessionRequest);
    const initializationResponse = await httpRequest(validationData.buildInitializationRequest(
      endpoints.validationInitializationEndpoint, pending.sessionRequest
    ));
    const sessionInfo = parsePlistData(
      requireHttpResponse(initializationResponse, 'session-info request'),
      'session-info', 'session-info'
    );

    let completion;
    const initializationCount = pending.count;
    for (let count = initializationCount; count <= MAX_RANDOM_WORDS; count += 1) {
      if (count !== initializationCount) {
        pending = await initializeAt(
          oracle, certificate, localHardware, count, `reinitialize-${count}`
        );
        if (!sameBytes(firstRequest, pending.sessionRequest)) {
          fail('NAC_CAPTURE_NONDETERMINISTIC', 'NAC initialization changed during discovery');
        }
      }
      try {
        completion = await completeAt(oracle, pending, sessionInfo, `complete-${count}`);
        pending = null;
        if (completion.arc4random_words_consumed !== count) {
          fail('NAC_CAPTURE_RANDOM_INVALID', 'oracle did not consume the exact random-word prefix');
        }
        break;
      } catch (error) {
        // A valid completion request consumes its native context even when deterministic random
        // input is exhausted or has an unused tail.
        pending = null;
        if (!isRandomMismatch(error)) throw error;
      }
    }
    if (!completion) fail('NAC_CAPTURE_RANDOM_EXHAUSTED', 'NAC completion exceeded the random-word limit');
    const validation = verifyCompletion(completion, completion.arc4random_words_consumed);
    const exactCount = completion.arc4random_words_consumed;

    pending = await initializeAt(
      oracle, certificate, localHardware, exactCount, 'repeat-initialize'
    );
    if (!sameBytes(firstRequest, pending.sessionRequest)) {
      fail('NAC_CAPTURE_NONDETERMINISTIC', 'repeated NAC initialization changed');
    }
    const repeated = await completeAt(oracle, pending, sessionInfo, 'repeat-complete');
    pending = null;
    const repeatedValidation = verifyCompletion(repeated, exactCount);
    if (!sameBytes(validation, repeatedValidation)) {
      fail('NAC_CAPTURE_NONDETERMINISTIC', 'repeated NAC completion changed');
    }

    const descriptor = (value) => ({
      base64: Buffer.from(value).toString('base64'),
      length: value.length,
      sha256: hash(value),
    });
    const vector = {
      schemaVersion: vectorModule.SCHEMA_VERSION,
      id: `apple-public-nac-${hash(certificate).slice(0, 16)}-${hash(sessionInfo).slice(0, 16)}`,
      oracle: {
        cortenCommit: completion.corten_commit,
        nacBinarySha1: completion.nac_binary_sha1,
        nacBinarySha256: completion.nac_binary_sha256,
        nacX86_64SliceSha256: completion.nac_x86_64_slice_sha256,
      },
      hardware: localHardware,
      arc4randomWords: deterministicRandomWords(exactCount),
      certificateChainBase64: Buffer.from(certificate).toString('base64'),
      sessionInfoBase64: Buffer.from(sessionInfo).toString('base64'),
      expected: {
        sessionInfoRequest: descriptor(firstRequest),
        validationData: descriptor(validation),
      },
    };
    vectorModule.validateVector(vector);
    return vector;
  } finally {
    await safeCancel(oracle, pending);
  }
}

async function boundedBody(response, maximum) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    fail('NAC_CAPTURE_HTTP_INVALID', 'HTTP response has no readable body');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maximum) {
        await reader.cancel();
        fail('NAC_CAPTURE_HTTP_INVALID', 'HTTP response exceeded its byte limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

export async function fetchHttpRequest(request) {
  if (!request || (request.method !== 'GET' && request.method !== 'POST')
      || typeof request.url !== 'string' || !Array.isArray(request.headers)
      || request.headers.length !== 0 || !(request.body instanceof Uint8Array)) {
    fail('NAC_CAPTURE_HTTP_INVALID', 'production HTTP request definition is malformed');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      body: request.body.length === 0 ? undefined : request.body,
      redirect: 'manual',
      credentials: 'omit',
      signal: controller.signal,
    });
    return {
      status: response.status,
      body: await boundedBody(response, request.maxResponseBytes || MAX_HTTP_BODY_BYTES),
    };
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('NAC_CAPTURE_')) throw error;
    fail('NAC_CAPTURE_HTTP_FAILED', 'account-credential-free Apple request failed');
  } finally {
    clearTimeout(timeout);
  }
}

export class OracleProcess {
  constructor(executable, binary) {
    this.child = spawn(executable, [], {
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        NAC_BINARY_FILE: binary,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    // Drain stderr so a native warning cannot deadlock the child. Protocol bytes are never copied
    // from stderr into an exception or console message.
    this.child.stderr.on('data', () => {});
    this.closed = false;
  }

  async request(value) {
    if (this.closed) fail('NAC_CAPTURE_ORACLE_EXITED', 'NAC oracle is not running');
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_ORACLE_LINE_BYTES) {
      fail('NAC_CAPTURE_ORACLE_INVALID', 'NAC oracle request exceeded its byte limit');
    }
    await new Promise((resolve, reject) => {
      this.child.stdin.write(`${encoded}\n`, (error) => error ? reject(error) : resolve());
    }).catch(() => fail('NAC_CAPTURE_ORACLE_EXITED', 'NAC oracle input closed'));
    const next = await this.lines.next();
    if (next.done || typeof next.value !== 'string'
        || Buffer.byteLength(next.value) > MAX_ORACLE_LINE_BYTES) {
      fail('NAC_CAPTURE_ORACLE_EXITED', 'NAC oracle output closed or exceeded its byte limit');
    }
    try { return JSON.parse(next.value); }
    catch (_) { fail('NAC_CAPTURE_ORACLE_INVALID', 'NAC oracle returned invalid JSON'); }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }
}

function explicitRegularFile(value, name, executable = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    fail('NAC_CAPTURE_PATH_INVALID', `${name} must be an explicit absolute path`);
  }
  let stat;
  try { stat = fs.lstatSync(value); } catch (_) { fail('NAC_CAPTURE_PATH_INVALID', `${name} is not readable`); }
  if (!stat.isFile() || stat.isSymbolicLink() || (executable && (stat.mode & 0o111) === 0)) {
    fail('NAC_CAPTURE_PATH_INVALID', `${name} must identify a regular${executable ? ' executable' : ''} file`);
  }
  return value;
}

function explicitNewOutput(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    fail('NAC_CAPTURE_PATH_INVALID', 'NAC_PARITY_VECTOR_FILE must be an explicit absolute path');
  }
  const parent = path.dirname(value);
  const stat = fs.lstatSync(parent);
  const relative = path.relative(repositoryRoot, value);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..') {
    fail('NAC_CAPTURE_PATH_INVALID', 'NAC_PARITY_VECTOR_FILE must stay outside the repository');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.existsSync(value)) {
    fail('NAC_CAPTURE_PATH_INVALID', 'NAC_PARITY_VECTOR_FILE must be a new file in a regular directory');
  }
  return value;
}

function writeNewPrivateFile(output, contents) {
  let descriptor;
  try {
    descriptor = fs.openSync(output, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(output, { force: true });
    fail('NAC_CAPTURE_WRITE_FAILED', 'could not write the local parity vector');
  }
  fs.closeSync(descriptor);
}

async function main() {
  const binary = explicitRegularFile(process.env.NAC_BINARY_FILE, 'NAC_BINARY_FILE');
  readAndVerifyBinary(binary);
  const executable = explicitRegularFile(
    process.env.NAC_ORACLE_FILE, 'NAC_ORACLE_FILE', true
  );
  const output = explicitNewOutput(process.env.NAC_PARITY_VECTOR_FILE);
  const hardwareKey = explicitRegularFile(
    process.env.NAC_HARDWARE_KEY_FILE, 'NAC_HARDWARE_KEY_FILE'
  );
  const hardwareRelative = path.relative(repositoryRoot, hardwareKey);
  if (!hardwareRelative.startsWith(`..${path.sep}`) && hardwareRelative !== '..') {
    fail('NAC_CAPTURE_PATH_INVALID', 'NAC_HARDWARE_KEY_FILE must stay outside the repository');
  }
  const hardwareKeyStat = fs.statSync(hardwareKey);
  if (hardwareKeyStat.size < 1 || hardwareKeyStat.size > 8 * 1024 * 1024) {
    fail('NAC_CAPTURE_PATH_INVALID', 'NAC_HARDWARE_KEY_FILE is outside its byte limit');
  }
  let parsedToken;
  try { parsedToken = macAuthToken.parseMacAuthToken(fs.readFileSync(hardwareKey, 'utf8')); }
  catch (_) { fail('NAC_CAPTURE_HARDWARE_INVALID', 'ExtractKey hardware file is invalid'); }
  const oracle = new OracleProcess(executable, binary);
  try {
    const vector = await capturePublicVector({
      oracle, httpRequest: fetchHttpRequest, hardware: parsedToken.hardware,
    });
    writeNewPrivateFile(output, `${JSON.stringify(vector, null, 2)}\n`);
    process.stdout.write('Captured and verified one account-credential-free NAC parity vector.\n');
  } finally {
    oracle.close();
    macAuthToken.disposeMacAuthToken(parsedToken);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'NAC_CAPTURE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
