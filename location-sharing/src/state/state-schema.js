'use strict';

var RuntimeError = require('../../../chat/imessage/src/runtime/errors').RuntimeError;
var ERROR_KINDS = require('../../../chat/imessage/src/runtime/errors').ERROR_KINDS;

var CURRENT_STATE_VERSION = 1;
var MAX_TREE_DEPTH = 32;
var MAX_TREE_NODES = 10000;
var PHASES = Object.freeze(['disconnected', 'configuring', 'needs-two-factor', 'ready']);
var FORBIDDEN_PERSISTED_FIELDS = Object.freeze({
  '2fa': true,
  '2facode': true,
  body: true,
  clientephemeral: true,
  content: true,
  message: true,
  messagebody: true,
  messagetext: true,
  outgoingmessage: true,
  outgoingpayload: true,
  otp: true,
  otpcode: true,
  password: true,
  passwordhash: true,
  pet: true,
  petexchange: true,
  petrequest: true,
  petresponse: true,
  plaintext: true,
  plaintextmessage: true,
  payload: true,
  srpephemeral: true,
  srpephemeralprivate: true,
  srpephemeralpublic: true,
  srpprivate: true,
  srpsecret: true,
  srpstate: true,
  srptranscript: true,
  text: true,
  twofactor: true,
  twofactorcode: true,
  verificationcode: true,
});

/**
 * @returns {PersistedState}
 */
function createEmptyState() {
  return {
    schemaVersion: CURRENT_STATE_VERSION,
    generation: 0,
    phase: 'disconnected',
    account: {
      id: null,
      handles: [],
    },
    artifacts: {
      provisioning: null,
      push: null,
      authentication: null,
      findMy: null,
      registration: null,
      identities: {},
      targetCache: {},
    },
    keyInventory: {
      active: [],
      cleanup: [],
    },
    counters: {},
  };
}

/**
 * Validate and clone a current-version persisted state.
 *
 * @param {unknown} value
 * @returns {PersistedState}
 */
function validateCurrentState(value) {
  if (!isPlainObject(value)) throw invalidState('Persisted state must be an object.');
  var state = /** @type {Record<string, unknown>} */ (value);
  assertExactKeys(state, [
    'schemaVersion',
    'generation',
    'phase',
    'account',
    'artifacts',
    'keyInventory',
    'counters',
  ]);
  if (state.schemaVersion !== CURRENT_STATE_VERSION) {
    throw invalidState('Persisted state has an unsupported schema version.');
  }
  assertNonNegativeSafeInteger(state.generation, 'State generation');
  if (typeof state.phase !== 'string' || PHASES.indexOf(state.phase) === -1) {
    throw invalidState('Persisted state has an invalid phase.');
  }

  validateAccount(state.account);
  validateArtifacts(state.artifacts);
  validateKeyInventory(state.keyInventory, /** @type {number} */ (state.generation));
  validateCounters(state.counters);
  assertSafePersistedTree(state);

  return /** @type {PersistedState} */ (cloneJson(state));
}

/** @param {unknown} value */
function validateAccount(value) {
  if (!isPlainObject(value)) throw invalidState('Persisted account must be an object.');
  var account = /** @type {Record<string, unknown>} */ (value);
  assertExactKeys(account, ['id', 'handles']);
  if (account.id !== null) assertBoundedString(account.id, 'Account id', 1024);
  if (!Array.isArray(account.handles)) throw invalidState('Account handles must be an array.');
  var seen = Object.create(null);
  account.handles.forEach(function (handle) {
    assertBoundedString(handle, 'Account handle', 1024);
    if (seen[handle]) throw invalidState('Account handles must be unique.');
    seen[handle] = true;
  });
}

/** @param {unknown} value */
function validateArtifacts(value) {
  if (!isPlainObject(value)) throw invalidState('Persisted artifacts must be an object.');
  var artifacts = /** @type {Record<string, unknown>} */ (value);
  assertExactKeys(artifacts, [
    'provisioning',
    'push',
    'authentication',
    'findMy',
    'registration',
    'identities',
    'targetCache',
  ]);
  ['provisioning', 'push', 'authentication', 'findMy', 'registration'].forEach(function (name) {
    if (artifacts[name] !== null && !isPlainObject(artifacts[name])) {
      throw invalidState('Persisted artifact records must be objects or null.');
    }
  });
  if (!isPlainObject(artifacts.identities) || !isPlainObject(artifacts.targetCache)) {
    throw invalidState('Persisted artifact collections must be objects.');
  }
}

/** @param {unknown} value @param {number} stateGeneration */
function validateKeyInventory(value, stateGeneration) {
  if (!isPlainObject(value)) throw invalidState('Key inventory must be an object.');
  var inventory = /** @type {Record<string, unknown>} */ (value);
  assertExactKeys(inventory, ['active', 'cleanup']);
  if (!Array.isArray(inventory.active) || !Array.isArray(inventory.cleanup)) {
    throw invalidState('Key inventory collections must be arrays.');
  }

  var seen = Object.create(null);
  inventory.active.forEach(function (entry) {
    validateActiveKey(entry);
    var active = /** @type {{id: string, createdGeneration: number}} */ (entry);
    if (active.createdGeneration > stateGeneration) {
      throw invalidState('Active key metadata references a future generation.');
    }
    var id = active.id;
    if (seen[id]) throw invalidState('Key ids must be unique.');
    seen[id] = true;
  });
  inventory.cleanup.forEach(function (entry) {
    validateCleanupKey(entry);
    var cleanup = /** @type {{id: string, createdGeneration: number, orphanedGeneration: number}} */ (entry);
    if (cleanup.createdGeneration > cleanup.orphanedGeneration || cleanup.orphanedGeneration > stateGeneration) {
      throw invalidState('Cleanup key metadata has invalid generations.');
    }
    var id = cleanup.id;
    if (seen[id]) throw invalidState('Key ids must be unique.');
    seen[id] = true;
  });
}

/** @param {unknown} value */
function validateActiveKey(value) {
  if (!isPlainObject(value)) throw invalidState('Active key metadata must be an object.');
  var entry = /** @type {Record<string, unknown>} */ (value);
  assertExactKeys(entry, ['id', 'purpose', 'createdGeneration']);
  assertBoundedString(entry.id, 'Key id', 1024);
  assertBoundedString(entry.purpose, 'Key purpose', 256);
  assertNonNegativeSafeInteger(entry.createdGeneration, 'Key generation');
}

/** @param {unknown} value */
function validateCleanupKey(value) {
  if (!isPlainObject(value)) throw invalidState('Cleanup key metadata must be an object.');
  var entry = /** @type {Record<string, unknown>} */ (value);
  assertExactKeys(entry, ['id', 'purpose', 'createdGeneration', 'orphanedGeneration', 'reason']);
  assertBoundedString(entry.id, 'Key id', 1024);
  assertBoundedString(entry.purpose, 'Key purpose', 256);
  assertNonNegativeSafeInteger(entry.createdGeneration, 'Key generation');
  assertNonNegativeSafeInteger(entry.orphanedGeneration, 'Key cleanup generation');
  assertBoundedString(entry.reason, 'Key cleanup reason', 256);
}

/** @param {unknown} value */
function validateCounters(value) {
  if (!isPlainObject(value)) throw invalidState('Message counters must be an object.');
  var counters = /** @type {Record<string, unknown>} */ (value);
  Object.keys(counters).forEach(function (scope) {
    assertCounterScope(scope);
    assertNonNegativeSafeInteger(counters[scope], 'Message counter');
  });
}

/** @param {unknown} value */
function assertCounterScope(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw invalidState('Counter scope must be a non-empty bounded string.');
  }
  if (value === '__proto__' || value === 'prototype' || value === 'constructor') {
    throw invalidState('Counter scope is reserved.');
  }
}

/**
 * Reject transient secrets and outgoing message content by field name before serialization.
 *
 * @param {unknown} root
 */
function assertSafePersistedTree(root) {
  var nodes = 0;

  /** @param {unknown} value @param {number} depth */
  function visit(value, depth) {
    nodes += 1;
    if (nodes > MAX_TREE_NODES || depth > MAX_TREE_DEPTH) {
      throw invalidState('Persisted state is too deeply nested or too large.');
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw invalidState('Persisted numbers must be finite.');
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (item) { visit(item, depth + 1); });
      return;
    }
    if (!isPlainObject(value)) throw invalidState('Persisted values must be JSON-compatible.');

    Object.keys(value).forEach(function (key) {
      var normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_PERSISTED_FIELDS[normalized]) {
        throw invalidState('Persisted state contains a transient or prohibited field.');
      }
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw invalidState('Persisted state contains a reserved field.');
      }
      visit(/** @type {Record<string, unknown>} */ (value)[key], depth + 1);
    });
  }

  visit(root, 0);
}

/** @param {Record<string, unknown>} value @param {ReadonlyArray<string>} expected */
function assertExactKeys(value, expected) {
  var keys = Object.keys(value).sort();
  var sortedExpected = expected.slice().sort();
  if (keys.length !== sortedExpected.length) throw invalidState('Persisted record has invalid fields.');
  for (var index = 0; index < keys.length; index += 1) {
    if (keys[index] !== sortedExpected[index]) throw invalidState('Persisted record has invalid fields.');
  }
}

/** @param {unknown} value @param {string} name @param {number} maxLength */
function assertBoundedString(value, name, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw invalidState(name + ' must be a non-empty bounded string.');
  }
}

/** @param {unknown} value @param {string} name */
function assertNonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw invalidState(name + ' must be a non-negative safe integer.');
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  var prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value @returns {unknown} */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {string} message @returns {RuntimeError} */
function invalidState(message) {
  return new RuntimeError('INVALID_PERSISTED_STATE', message, { kind: ERROR_KINDS.STORAGE });
}

/**
 * @typedef {object} PersistedState
 * @property {number} schemaVersion
 * @property {number} generation
 * @property {'disconnected'|'configuring'|'needs-two-factor'|'ready'} phase
 * @property {{id: string|null, handles: Array<string>}} account
 * @property {{provisioning: object|null, push: object|null, authentication: object|null, findMy: object|null, registration: object|null, identities: Record<string, unknown>, targetCache: Record<string, unknown>}} artifacts
 * @property {{active: Array<{id: string, purpose: string, createdGeneration: number}>, cleanup: Array<{id: string, purpose: string, createdGeneration: number, orphanedGeneration: number, reason: string}>}} keyInventory
 * @property {Record<string, number>} counters
 */

module.exports = {
  CURRENT_STATE_VERSION: CURRENT_STATE_VERSION,
  PHASES: PHASES,
  assertCounterScope: assertCounterScope,
  assertSafePersistedTree: assertSafePersistedTree,
  createEmptyState: createEmptyState,
  validateCurrentState: validateCurrentState,
};
