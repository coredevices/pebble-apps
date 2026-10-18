'use strict';

var schema = require('./state-schema');
var RuntimeError = require('../../../chat/imessage/src/runtime/errors').RuntimeError;
var ERROR_KINDS = require('../../../chat/imessage/src/runtime/errors').ERROR_KINDS;

/**
 * Migrate a decoded persisted value into the current schema. The empty storage value and the
 * original version-zero shape are the only legacy inputs accepted.
 *
 * @param {unknown} value
 * @returns {{state: import('./state-schema').PersistedState, migrated: boolean}}
 */
function migrateState(value) {
  if (value === null || value === undefined || isEmptyObject(value)) {
    return { state: schema.createEmptyState(), migrated: value !== null && value !== undefined };
  }
  if (!isPlainObject(value)) throw migrationError('Persisted state must decode to an object.');

  var record = /** @type {Record<string, unknown>} */ (value);
  if (record.schemaVersion === schema.CURRENT_STATE_VERSION) {
    return { state: schema.validateCurrentState(record), migrated: false };
  }
  if (record.schemaVersion !== 0) {
    throw migrationError('Persisted state has an unsupported schema version.');
  }
  return { state: migrateVersionZero(record), migrated: true };
}

/**
 * Version zero had no cleanup queue: all listed key ids were considered active.
 *
 * @param {Record<string, unknown>} oldState
 * @returns {import('./state-schema').PersistedState}
 */
function migrateVersionZero(oldState) {
  assertExactKeys(oldState, [
    'schemaVersion',
    'generation',
    'phase',
    'account',
    'artifacts',
    'keys',
    'counters',
  ]);
  if (!Array.isArray(oldState.keys)) throw migrationError('Version-zero keys must be an array.');

  var candidate = {
    schemaVersion: schema.CURRENT_STATE_VERSION,
    generation: oldState.generation,
    phase: oldState.phase,
    account: oldState.account,
    artifacts: oldState.artifacts,
    keyInventory: {
      active: oldState.keys,
      cleanup: [],
    },
    counters: oldState.counters,
  };
  return schema.validateCurrentState(candidate);
}

/** @param {unknown} value @returns {boolean} */
function isEmptyObject(value) {
  return isPlainObject(value) && Object.keys(/** @type {object} */ (value)).length === 0;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  var prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {Record<string, unknown>} value @param {ReadonlyArray<string>} expected */
function assertExactKeys(value, expected) {
  var keys = Object.keys(value).sort();
  var sortedExpected = expected.slice().sort();
  if (keys.length !== sortedExpected.length) throw migrationError('Version-zero state has invalid fields.');
  for (var index = 0; index < keys.length; index += 1) {
    if (keys[index] !== sortedExpected[index]) {
      throw migrationError('Version-zero state has invalid fields.');
    }
  }
}

/** @param {string} message @returns {RuntimeError} */
function migrationError(message) {
  return new RuntimeError('STATE_MIGRATION_FAILED', message, { kind: ERROR_KINDS.STORAGE });
}

module.exports = {
  migrateState: migrateState,
};
