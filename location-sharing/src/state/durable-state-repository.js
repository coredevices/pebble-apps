'use strict';

var schema = require('./state-schema');
var migrateState = require('./state-migrations').migrateState;
var errors = require('../../../imessage/src/runtime/errors');
var RuntimeError = errors.RuntimeError;
var ERROR_KINDS = errors.ERROR_KINDS;

var DEFAULT_STORAGE_PREFIX = 'imessage-js.state';

/**
 * Crash-safe repository over the injected synchronous storage effect. Callers must serialize
 * writers for one storage prefix; the host storage contract does not expose compare-and-swap.
 *
 * @param {{storage: {get: Function, set: Function, delete: Function}}} effects
 * @param {{storagePrefix?: string}=} options
 * @constructor
 */
function DurableStateRepository(effects, options) {
  if (!effects || !effects.storage) {
    throw invalidArgument('Durable state requires injected storage effects.');
  }
  options = options || {};
  var prefix = options.storagePrefix === undefined ? DEFAULT_STORAGE_PREFIX : options.storagePrefix;
  if (typeof prefix !== 'string' || prefix.length === 0 || prefix.length > 512) {
    throw invalidArgument('Storage prefix must be a non-empty bounded string.');
  }
  this._storage = effects.storage;
  this._committedKey = prefix + '.committed';
  this._pendingKey = prefix + '.pending';
}

/**
 * Load current state and finish or discard an interrupted generation.
 *
 * @returns {Readonly<import('./state-schema').PersistedState>}
 */
DurableStateRepository.prototype.load = function () {
  var committed = this._readSlot(this._committedKey);
  var pending = this._readSlot(this._pendingKey);

  if (!committed.exists && !pending.exists) return freezeSnapshot(schema.createEmptyState());
  if (!committed.valid && !pending.valid) {
    throw corruptState('No recoverable persisted state generation exists.');
  }

  var chosen;
  var promotePending = false;
  if (pending.valid && (!committed.valid || pending.state.generation >= committed.state.generation)) {
    chosen = pending;
    promotePending = true;
  } else {
    chosen = committed;
  }

  if (promotePending || chosen.migrated || !committed.valid) {
    this._set(this._committedKey, serializeState(chosen.state));
  }
  if (pending.exists) this._delete(this._pendingKey);

  return freezeSnapshot(chosen.state);
};

/**
 * Apply a synchronous mutation and durably publish its next generation.
 *
 * @param {(draft: import('./state-schema').PersistedState) => unknown} mutator
 * @returns {Readonly<import('./state-schema').PersistedState>}
 */
DurableStateRepository.prototype.update = function (mutator) {
  return this._update(mutator, false);
};

/**
 * Increment and persist a scoped counter before returning it to the encrypting caller. Failed or
 * interrupted commits can burn a value but can never return it twice after recovery.
 *
 * @param {string} scope
 * @returns {number}
 */
DurableStateRepository.prototype.reserveMessageCounter = function (scope) {
  schema.assertCounterScope(scope);
  var reserved;
  this._update(function (draft) {
    var previous = Object.prototype.hasOwnProperty.call(draft.counters, scope)
      ? draft.counters[scope]
      : 0;
    if (previous === Number.MAX_SAFE_INTEGER) {
      throw new RuntimeError('MESSAGE_COUNTER_EXHAUSTED', 'Message counter is exhausted.', {
        kind: ERROR_KINDS.STORAGE,
      });
    }
    reserved = previous + 1;
    draft.counters[scope] = reserved;
  }, false);
  return /** @type {number} */ (reserved);
};

/**
 * Record a key-vault id after the generic host has created the key.
 *
 * @param {string} keyId
 * @param {string} purpose
 * @returns {Readonly<import('./state-schema').PersistedState>}
 */
DurableStateRepository.prototype.recordKey = function (keyId, purpose) {
  assertMetadataString(keyId, 'Key id', 1024);
  assertMetadataString(purpose, 'Key purpose', 256);
  return this._update(function (draft) {
    if (findKeyIndex(draft.keyInventory.active, keyId) !== -1) {
      throw invalidArgument('Key id is already active.');
    }
    var cleanupIndex = findKeyIndex(draft.keyInventory.cleanup, keyId);
    if (cleanupIndex !== -1) draft.keyInventory.cleanup.splice(cleanupIndex, 1);
    draft.keyInventory.active.push({
      id: keyId,
      purpose: purpose,
      createdGeneration: draft.generation + 1,
    });
  }, false);
};

/**
 * Durably record a newly-created host key as pending cleanup before the caller performs work that
 * can suspend. This is the safe staging state for a persistent key that is not yet referenced by
 * a committed protocol artifact: a restarted session can discover and delete it.
 *
 * @param {string} keyId
 * @param {string} purpose
 * @param {string} reason
 * @returns {Readonly<import('./state-schema').PersistedState>}
 */
DurableStateRepository.prototype.recordKeyCleanup = function (keyId, purpose, reason) {
  assertMetadataString(keyId, 'Key id', 1024);
  assertMetadataString(purpose, 'Key purpose', 256);
  assertMetadataString(reason, 'Key cleanup reason', 256);
  return this._update(function (draft) {
    if (findKeyIndex(draft.keyInventory.active, keyId) !== -1
        || findKeyIndex(draft.keyInventory.cleanup, keyId) !== -1) {
      throw invalidArgument('Key id is already tracked.');
    }
    var generation = draft.generation + 1;
    draft.keyInventory.cleanup.push({
      id: keyId,
      purpose: purpose,
      createdGeneration: generation,
      orphanedGeneration: generation,
      reason: reason,
    });
  }, false);
};

/**
 * Move an active key into the cleanup queue. The caller deletes it through the host key vault and
 * acknowledges that deletion with completeKeyCleanup.
 *
 * @param {string} keyId
 * @param {string} reason
 * @returns {Readonly<import('./state-schema').PersistedState>}
 */
DurableStateRepository.prototype.retireKey = function (keyId, reason) {
  assertMetadataString(keyId, 'Key id', 1024);
  assertMetadataString(reason, 'Key cleanup reason', 256);
  return this._update(function (draft) {
    var index = findKeyIndex(draft.keyInventory.active, keyId);
    if (index === -1) {
      throw new RuntimeError('KEY_NOT_TRACKED', 'Key id is not active.', {
        kind: ERROR_KINDS.STORAGE,
      });
    }
    var active = draft.keyInventory.active.splice(index, 1)[0];
    draft.keyInventory.cleanup.push({
      id: active.id,
      purpose: active.purpose,
      createdGeneration: active.createdGeneration,
      orphanedGeneration: draft.generation + 1,
      reason: reason,
    });
  }, false);
};

/**
 * Remove cleanup metadata only after the generic host confirms key deletion.
 *
 * @param {string} keyId
 * @returns {Readonly<import('./state-schema').PersistedState>}
 */
DurableStateRepository.prototype.completeKeyCleanup = function (keyId) {
  assertMetadataString(keyId, 'Key id', 1024);
  return this._update(function (draft) {
    var index = findKeyIndex(draft.keyInventory.cleanup, keyId);
    if (index === -1) {
      throw new RuntimeError('KEY_NOT_PENDING_CLEANUP', 'Key id is not pending cleanup.', {
        kind: ERROR_KINDS.STORAGE,
      });
    }
    draft.keyInventory.cleanup.splice(index, 1);
  }, false);
};

/**
 * @returns {ReadonlyArray<Readonly<{id: string, purpose: string, createdGeneration: number, orphanedGeneration: number, reason: string}>>}
 */
DurableStateRepository.prototype.pendingKeyCleanup = function () {
  return this.load().keyInventory.cleanup;
};

/**
 * Clear account/protocol state while retaining the key ids that still need host deletion.
 *
 * @param {string=} reason
 * @returns {Readonly<import('./state-schema').PersistedState>}
 */
DurableStateRepository.prototype.resetForDisconnect = function (reason) {
  var cleanupReason = reason === undefined ? 'disconnect' : reason;
  assertMetadataString(cleanupReason, 'Key cleanup reason', 256);
  return this._update(function (draft) {
    var orphanedGeneration = draft.generation + 1;
    draft.keyInventory.active.forEach(function (active) {
      draft.keyInventory.cleanup.push({
        id: active.id,
        purpose: active.purpose,
        createdGeneration: active.createdGeneration,
        orphanedGeneration: orphanedGeneration,
        reason: cleanupReason,
      });
    });
    draft.keyInventory.active = [];
    draft.phase = 'disconnected';
    draft.account = { id: null, handles: [] };
    draft.artifacts = schema.createEmptyState().artifacts;
    draft.counters = {};
  }, true);
};

/**
 * @param {(draft: import('./state-schema').PersistedState) => unknown} mutator
 * @param {boolean} allowCounterReset
 * @returns {Readonly<import('./state-schema').PersistedState>}
 * @private
 */
DurableStateRepository.prototype._update = function (mutator, allowCounterReset) {
  if (typeof mutator !== 'function') throw invalidArgument('State mutator must be a function.');
  var current = this.load();
  if (current.generation === Number.MAX_SAFE_INTEGER) {
    throw new RuntimeError('STATE_GENERATION_EXHAUSTED', 'State generation is exhausted.', {
      kind: ERROR_KINDS.STORAGE,
    });
  }

  var draft = cloneJson(current);
  var result = mutator(draft);
  if (result && typeof result === 'object' && typeof result.then === 'function') {
    throw invalidArgument('State mutator must be synchronous.');
  }
  draft.schemaVersion = schema.CURRENT_STATE_VERSION;
  draft.generation = current.generation + 1;
  var next = schema.validateCurrentState(draft);
  if (!allowCounterReset) assertCountersNeverDecrease(current.counters, next.counters);

  var serialized = serializeState(next);
  this._set(this._pendingKey, serialized);
  this._set(this._committedKey, serialized);
  this._delete(this._pendingKey);
  return freezeSnapshot(next);
};

/** @param {string} key @returns {{exists: boolean, valid: boolean, state?: import('./state-schema').PersistedState, migrated?: boolean}} */
DurableStateRepository.prototype._readSlot = function (key) {
  var raw = this._get(key);
  if (raw === null || raw === undefined) return { exists: false, valid: false };
  if (typeof raw !== 'string') return { exists: true, valid: false };

  try {
    var decoded = JSON.parse(raw);
    var migrated = migrateState(decoded);
    return {
      exists: true,
      valid: true,
      state: migrated.state,
      migrated: migrated.migrated,
    };
  } catch (_) {
    return { exists: true, valid: false };
  }
};

/** @param {string} key @returns {unknown} @private */
DurableStateRepository.prototype._get = function (key) {
  try {
    return this._storage.get(key);
  } catch (error) {
    throw storageFailure(error, 'Unable to read durable state.');
  }
};

/** @param {string} key @param {string} value @private */
DurableStateRepository.prototype._set = function (key, value) {
  try {
    this._storage.set(key, value);
  } catch (error) {
    throw storageFailure(error, 'Unable to write durable state.');
  }
};

/** @param {string} key @private */
DurableStateRepository.prototype._delete = function (key) {
  try {
    this._storage.delete(key);
  } catch (error) {
    throw storageFailure(error, 'Unable to finalize durable state.');
  }
};

/** @param {Record<string, number>} previous @param {Record<string, number>} next */
function assertCountersNeverDecrease(previous, next) {
  Object.keys(previous).forEach(function (scope) {
    if (!Object.prototype.hasOwnProperty.call(next, scope) || next[scope] < previous[scope]) {
      throw new RuntimeError('MESSAGE_COUNTER_ROLLBACK', 'State update would roll back a message counter.', {
        kind: ERROR_KINDS.STORAGE,
      });
    }
  });
}

/** @param {Array<{id: string}>} entries @param {string} keyId @returns {number} */
function findKeyIndex(entries, keyId) {
  for (var index = 0; index < entries.length; index += 1) {
    if (entries[index].id === keyId) return index;
  }
  return -1;
}

/** @param {unknown} value @param {string} name @param {number} maxLength */
function assertMetadataString(value, name, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw invalidArgument(name + ' must be a non-empty bounded string.');
  }
}

/** @param {import('./state-schema').PersistedState} state @returns {string} */
function serializeState(state) {
  try {
    return JSON.stringify(state);
  } catch (error) {
    throw storageFailure(error, 'Unable to serialize durable state.');
  }
}

/** @param {unknown} value @returns {unknown} */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @template T @param {T} value @returns {Readonly<T>} */
function freezeSnapshot(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.keys(value).forEach(function (key) {
    freezeSnapshot(/** @type {Record<string, unknown>} */ (value)[key]);
  });
  return Object.freeze(value);
}

/** @param {string} message @returns {RuntimeError} */
function invalidArgument(message) {
  return new RuntimeError('INVALID_STATE_ARGUMENT', message, { kind: ERROR_KINDS.INVALID_INPUT });
}

/** @param {string} message @returns {RuntimeError} */
function corruptState(message) {
  return new RuntimeError('CORRUPT_DURABLE_STATE', message, { kind: ERROR_KINDS.STORAGE });
}

/** @param {unknown} cause @param {string} message @returns {RuntimeError} */
function storageFailure(cause, message) {
  return errors.asRuntimeError(cause, 'STATE_STORAGE_FAILED', message, {
    kind: ERROR_KINDS.STORAGE,
    retryable: false,
  });
}

module.exports = {
  DEFAULT_STORAGE_PREFIX: DEFAULT_STORAGE_PREFIX,
  DurableStateRepository: DurableStateRepository,
};
