'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var createEffects = require('../../src/runtime/effects').createEffects;
var schema = require('../../src/state/state-schema');
var migrateState = require('../../src/state/state-migrations').migrateState;
var repositoryModule = require('../../src/state/durable-state-repository');
var DurableStateRepository = repositoryModule.DurableStateRepository;

function MemoryStorage() {
  this.values = Object.create(null);
  this.mutation = 0;
  this.failure = null;
}

MemoryStorage.prototype.get = function (key) {
  return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
};

MemoryStorage.prototype.set = function (key, value) {
  this._mutate(function () { this.values[key] = value; });
};

MemoryStorage.prototype.delete = function (key) {
  this._mutate(function () { delete this.values[key]; });
};

MemoryStorage.prototype.armFailure = function (mutation, after) {
  this.mutation = 0;
  this.failure = { mutation: mutation, after: after };
};

MemoryStorage.prototype.disarm = function () {
  this.mutation = 0;
  this.failure = null;
};

MemoryStorage.prototype._mutate = function (operation) {
  this.mutation += 1;
  var shouldFail = this.failure && this.failure.mutation === this.mutation;
  if (shouldFail && !this.failure.after) throw new Error('simulated crash before mutation');
  operation.call(this);
  if (shouldFail) throw new Error('simulated crash after mutation');
};

function createRepository(storage, prefix) {
  return new DurableStateRepository(createEffects({ storage: storage }), {
    storagePrefix: prefix || 'test.state',
  });
}

test('empty storage yields an immutable current-version disconnected state without writing', function () {
  var storage = new MemoryStorage();
  var state = createRepository(storage).load();

  assert.equal(state.schemaVersion, schema.CURRENT_STATE_VERSION);
  assert.equal(state.generation, 0);
  assert.equal(state.phase, 'disconnected');
  assert.deepEqual(state.counters, {});
  assert.deepEqual(storage.values, Object.create(null));
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.artifacts), true);
  assert.throws(function () { state.phase = 'ready'; }, TypeError);
});

test('current state round-trips through a pending then committed generation', function () {
  var storage = new MemoryStorage();
  var repository = createRepository(storage);
  var next = repository.update(function (draft) {
    draft.phase = 'ready';
    draft.account.id = 'account-id';
    draft.account.handles.push('sender@example.test');
    draft.artifacts.registration = { certificate: 'synthetic-certificate' };
  });

  assert.equal(next.generation, 1);
  assert.equal(next.phase, 'ready');
  assert.equal(storage.get('test.state.pending'), null);
  assert.equal(JSON.parse(storage.get('test.state.committed')).generation, 1);
  assert.deepEqual(createRepository(storage).load(), next);
});

test('version-zero state migrates and is rewritten in the current schema', function () {
  var storage = new MemoryStorage();
  var empty = schema.createEmptyState();
  storage.values['test.state.committed'] = JSON.stringify({
    schemaVersion: 0,
    generation: 4,
    phase: 'ready',
    account: { id: 'synthetic-account', handles: ['sender@example.test'] },
    artifacts: empty.artifacts,
    keys: [{ id: 'vault-key-1', purpose: 'signing', createdGeneration: 3 }],
    counters: { identity1: 7 },
  });

  var state = createRepository(storage).load();

  assert.equal(state.schemaVersion, schema.CURRENT_STATE_VERSION);
  assert.equal(state.generation, 4);
  assert.deepEqual(state.keyInventory.cleanup, []);
  assert.equal(state.keyInventory.active[0].id, 'vault-key-1');
  assert.equal(JSON.parse(storage.values['test.state.committed']).schemaVersion, schema.CURRENT_STATE_VERSION);
  assert.equal(migrateState({}).migrated, true);
});

test('schema rejects transient credentials and outgoing plaintext fields at every artifact depth', function () {
  var repository = createRepository(new MemoryStorage());
  [
    { password: 'do-not-store' },
    { password_hash: 'do-not-store' },
    { srpEphemeral: 'do-not-store' },
    { pet_exchange: 'do-not-store' },
    { twoFactorCode: '000000' },
    { '2fa_code': '000000' },
    { nested: { plaintextMessage: 'do-not-store' } },
    { nested: { body: 'do-not-store' } },
    { nested: { payload: 'do-not-store' } },
  ].forEach(function (prohibited) {
    assert.throws(function () {
      repository.update(function (draft) {
        draft.artifacts.authentication = prohibited;
      });
    }, function (error) {
      return error.code === 'INVALID_PERSISTED_STATE' && !error.message.includes('do-not-store');
    });
  });
  assert.equal(repository.load().generation, 0);
});

test('corrupt pending state is discarded while a valid committed generation survives', function () {
  var storage = new MemoryStorage();
  var repository = createRepository(storage);
  repository.reserveMessageCounter('identity');
  storage.values['test.state.pending'] = '{not-json';

  var recovered = createRepository(storage).load();

  assert.equal(recovered.counters.identity, 1);
  assert.equal(storage.get('test.state.pending'), null);
});

test('a newer pending generation is promoted during crash recovery', function () {
  var storage = new MemoryStorage();
  var repository = createRepository(storage);
  repository.reserveMessageCounter('identity');
  var pending = JSON.parse(storage.values['test.state.committed']);
  pending.generation = 2;
  pending.counters.identity = 2;
  storage.values['test.state.pending'] = JSON.stringify(pending);

  var recovered = createRepository(storage).load();

  assert.equal(recovered.generation, 2);
  assert.equal(recovered.counters.identity, 2);
  assert.equal(JSON.parse(storage.values['test.state.committed']).generation, 2);
  assert.equal(storage.get('test.state.pending'), null);
});

test('reserveMessageCounter persists before returning and never reuses after every crash point', function () {
  [1, 2, 3].forEach(function (mutation) {
    [false, true].forEach(function (after) {
      var storage = new MemoryStorage();
      var repository = createRepository(storage);
      assert.equal(repository.reserveMessageCounter('identity'), 1);

      storage.armFailure(mutation, after);
      assert.throws(function () { repository.reserveMessageCounter('identity'); }, /durable state|simulated crash/i);
      storage.disarm();

      var recovered = createRepository(storage);
      var recoveredValue = recovered.load().counters.identity;
      assert.ok(recoveredValue >= 1 && recoveredValue <= 2);
      assert.ok(recovered.reserveMessageCounter('identity') > 1);
    });
  });
});

test('ordinary state updates cannot remove or roll back a reserved counter', function () {
  var repository = createRepository(new MemoryStorage());
  repository.reserveMessageCounter('identity');

  assert.throws(function () {
    repository.update(function (draft) { draft.counters.identity = 0; });
  }, function (error) { return error.code === 'MESSAGE_COUNTER_ROLLBACK'; });
  assert.throws(function () {
    repository.update(function (draft) { delete draft.counters.identity; });
  }, function (error) { return error.code === 'MESSAGE_COUNTER_ROLLBACK'; });
  assert.equal(repository.load().counters.identity, 1);
});

test('key inventory tracks cleanup metadata until host deletion is acknowledged', function () {
  var repository = createRepository(new MemoryStorage());
  var active = repository.recordKey('vault-key-1', 'identity-signing');
  assert.deepEqual(active.keyInventory.active, [{
    id: 'vault-key-1',
    purpose: 'identity-signing',
    createdGeneration: 1,
  }]);

  var retired = repository.retireKey('vault-key-1', 'rotated');
  assert.deepEqual(retired.keyInventory.active, []);
  assert.deepEqual(repository.pendingKeyCleanup(), [{
    id: 'vault-key-1',
    purpose: 'identity-signing',
    createdGeneration: 1,
    orphanedGeneration: 2,
    reason: 'rotated',
  }]);

  repository.completeKeyCleanup('vault-key-1');
  assert.deepEqual(repository.pendingKeyCleanup(), []);
});

test('new persistent keys can be staged for cleanup before their first suspending operation', function () {
  var repository = createRepository(new MemoryStorage());
  var staged = repository.recordKeyCleanup('unpublished-key', 'push-signing', 'publication-pending');

  assert.deepEqual(staged.keyInventory.active, []);
  assert.deepEqual(staged.keyInventory.cleanup, [{
    id: 'unpublished-key',
    purpose: 'push-signing',
    createdGeneration: 1,
    orphanedGeneration: 1,
    reason: 'publication-pending',
  }]);
  assert.throws(function () {
    repository.recordKeyCleanup('unpublished-key', 'push-signing', 'publication-pending');
  }, /already tracked/i);
});

test('disconnect clears account artifacts and counters but preserves every key cleanup obligation', function () {
  var repository = createRepository(new MemoryStorage());
  repository.recordKey('vault-key-1', 'push-signing');
  repository.reserveMessageCounter('identity');
  repository.update(function (draft) {
    draft.phase = 'ready';
    draft.account.id = 'synthetic-account';
    draft.artifacts.push = { token: 'synthetic-token' };
  });

  var disconnected = repository.resetForDisconnect();

  assert.equal(disconnected.phase, 'disconnected');
  assert.deepEqual(disconnected.account, { id: null, handles: [] });
  assert.deepEqual(disconnected.artifacts, schema.createEmptyState().artifacts);
  assert.deepEqual(disconnected.counters, {});
  assert.deepEqual(disconnected.keyInventory.active, []);
  assert.equal(disconnected.keyInventory.cleanup[0].id, 'vault-key-1');
  assert.equal(disconnected.keyInventory.cleanup[0].reason, 'disconnect');
});

test('unsupported or wholly corrupt storage fails closed without exposing stored values', function () {
  var storage = new MemoryStorage();
  storage.values['test.state.committed'] = JSON.stringify({
    schemaVersion: 99,
    secret: 'must-not-appear',
  });

  assert.throws(function () { createRepository(storage).load(); }, function (error) {
    return error.code === 'CORRUPT_DURABLE_STATE' && !error.message.includes('must-not-appear');
  });
});
