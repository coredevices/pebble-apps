'use strict';

const { decodeByteString, isByteString, validateJson } = require('./schema');

const FIXTURE_SCHEMA_VERSION = 1;
const FIXTURE_CLASSES = Object.freeze([
  'standards',
  'synthetic-protocol',
  'structural-trace',
  'encrypted-local-replay',
]);
const COMPARISON_MODES = Object.freeze(['exact', 'semantic']);

const SECRET_RULES = Object.freeze([
  {
    name: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  },
  {
    name: 'credential-assignment',
    pattern: /(?:password|passcode|two[-_ ]?factor|2fa|authorization|cookie|session[-_ ]?token|validation[-_ ]?data)\s*[:=]\s*["']?[^\s"']{6,}/i,
  },
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  },
]);

const SENSITIVE_KEYS = Object.freeze(new Set([
  'password',
  'passcode',
  'twofactor',
  '2fa',
  'authorization',
  'cookie',
  'token',
  'sessiontoken',
  'validationdata',
  'secret',
  'privatekey',
  'plaintext',
  'message',
  'text',
  'body',
  'payload',
  'data',
  'parameters',
  'result',
  'value',
]));

class FixtureValidationError extends Error {
  constructor(path, message) {
    super(`Invalid fixture metadata at ${path}: ${message}`);
    this.name = 'FixtureValidationError';
    this.path = path;
  }
}

function fail(path, message) {
  throw new FixtureValidationError(path, message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected non-empty string');
}

function validateFixtureMetadata(metadata) {
  if (!plainObject(metadata)) fail('$', 'expected object');
  const allowed = new Set([
    'schemaVersion',
    'id',
    'class',
    'oracle',
    'deterministic',
    'expectedPhase',
    'comparison',
    'description',
  ]);
  for (const key of Object.keys(metadata)) {
    if (!allowed.has(key)) fail(`$.${key}`, 'unknown field');
  }
  if (metadata.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    fail('$.schemaVersion', `expected ${FIXTURE_SCHEMA_VERSION}`);
  }
  requireString(metadata.id, '$.id');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(metadata.id)) {
    fail('$.id', 'must be a stable lowercase identifier');
  }
  if (!FIXTURE_CLASSES.includes(metadata.class)) {
    fail('$.class', `expected one of ${FIXTURE_CLASSES.join(', ')}`);
  }
  requireString(metadata.expectedPhase, '$.expectedPhase');
  if (!COMPARISON_MODES.includes(metadata.comparison)) {
    fail('$.comparison', `expected one of ${COMPARISON_MODES.join(', ')}`);
  }
  if (metadata.description !== undefined) requireString(metadata.description, '$.description');

  if (!plainObject(metadata.deterministic)) fail('$.deterministic', 'expected object');
  const deterministicKeys = Object.keys(metadata.deterministic);
  for (const key of deterministicKeys) {
    if (key !== 'seed' && key !== 'nowMs') fail(`$.deterministic.${key}`, 'unknown field');
  }
  if (!Number.isSafeInteger(metadata.deterministic.seed)
    || metadata.deterministic.seed < 0
    || metadata.deterministic.seed > 0xffffffff) {
    fail('$.deterministic.seed', 'expected unsigned 32-bit integer');
  }
  if (!Number.isSafeInteger(metadata.deterministic.nowMs) || metadata.deterministic.nowMs < 0) {
    fail('$.deterministic.nowMs', 'expected non-negative safe integer');
  }

  if (metadata.oracle !== undefined) {
    if (!plainObject(metadata.oracle)) fail('$.oracle', 'expected object');
    for (const key of Object.keys(metadata.oracle)) {
      if (key !== 'repository' && key !== 'commit') fail(`$.oracle.${key}`, 'unknown field');
    }
    requireString(metadata.oracle.repository, '$.oracle.repository');
    if (typeof metadata.oracle.commit !== 'string' || !/^[0-9a-f]{40}$/.test(metadata.oracle.commit)) {
      fail('$.oracle.commit', 'expected lowercase 40-character commit hash');
    }
  } else if (metadata.class !== 'standards') {
    fail('$.oracle', 'required for non-standards fixtures');
  }

  validateJson(metadata);
  return metadata;
}

function summarizeSensitive(value) {
  if (isByteString(value)) {
    return { redacted: true, type: 'bytes', length: decodeByteString(value).length };
  }
  if (typeof value === 'string') {
    return { redacted: true, type: 'string', length: value.length };
  }
  if (Array.isArray(value)) {
    return { redacted: true, type: 'array', length: value.length };
  }
  if (value !== null && typeof value === 'object') {
    return { redacted: true, type: 'object', keys: Object.keys(value).sort() };
  }
  return { redacted: true, type: value === null ? 'null' : typeof value };
}

function isSensitiveKey(keyName) {
  return SENSITIVE_KEYS.has(keyName.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function redactHeaders(headers, path) {
  return headers.map((header, index) => {
    if (!Array.isArray(header) || header.length !== 2 || typeof header[0] !== 'string') {
      return redactTrace(header, `${path}[${index}]`);
    }
    const name = header[0];
    if (/(?:authorization|cookie|token|secret)/i.test(name)) {
      return [name, summarizeSensitive(header[1])];
    }
    return [name, header[1]];
  });
}

function redactTrace(value, path = '$', keyName = '') {
  validateJson(value, path);
  if (keyName && isSensitiveKey(keyName)) return summarizeSensitive(value);
  if (keyName === 'headers' && Array.isArray(value)) return redactHeaders(value, path);
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactTrace(entry, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value)) {
      result[key] = redactTrace(value[key], `${path}.${key}`, key);
    }
    return result;
  }
  return value;
}

function scanForSecrets(value, path = '$', matches = []) {
  if (typeof value === 'string') {
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(value)) matches.push({ path, rule: rule.name });
    }
    return matches;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForSecrets(entry, `${path}[${index}]`, matches));
    return matches;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) scanForSecrets(value[key], `${path}.${key}`, matches);
  }
  return matches;
}

function assertNoSecrets(value) {
  const matches = scanForSecrets(value);
  if (matches.length > 0) {
    const first = matches[0];
    throw new Error(`Potential ${first.rule} secret at ${first.path}`);
  }
  return value;
}

module.exports = {
  COMPARISON_MODES,
  FIXTURE_CLASSES,
  FIXTURE_SCHEMA_VERSION,
  FixtureValidationError,
  assertNoSecrets,
  redactTrace,
  scanForSecrets,
  validateFixtureMetadata,
};
