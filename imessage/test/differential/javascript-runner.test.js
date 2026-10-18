'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  JavaScriptRunner,
  RunnerProtocolError,
  byteString,
  createEffect,
  createEvent,
} = require('../../harness');

function createImplementation() {
  const state = { phase: 'new', imported: null };
  return {
    start(operation, persistedState) {
      state.phase = operation;
      state.imported = persistedState;
      persistedState.nested.value = 'mutated only inside implementation';
      return [createEffect('random.request', { requestId: 'random-1', length: 2 })];
    },
    step(event) {
      state.phase = 'done';
      return [createEffect('terminal.result', { result: { random: event.data } })];
    },
    snapshot() { return state; },
  };
}

test('JavaScriptRunner clones inputs and validates a correlated step', async () => {
  const persisted = { nested: { value: 'outside' } };
  const runner = new JavaScriptRunner(createImplementation(), { name: 'fixture' });
  await runner.start('test-operation', persisted, { seed: 3 });
  assert.equal(persisted.nested.value, 'outside');

  const terminal = await runner.step(createEvent('random.result', {
    requestId: 'random-1',
    data: byteString([4, 5]),
  }));
  assert.equal(terminal[0].kind, 'terminal.result');
  assert.deepEqual((await runner.snapshot()).imported, {
    nested: { value: 'mutated only inside implementation' },
  });
});

test('JavaScriptRunner rejects mismatched responses and invalid yield batches', async () => {
  const runner = new JavaScriptRunner(createImplementation());
  await runner.start('test-operation', { nested: { value: 'x' } }, {});
  await assert.rejects(() => runner.step(createEvent('random.result', {
    requestId: 'wrong',
    data: byteString([1, 2]),
  })), /expected "random-1"/);

  const stalled = new JavaScriptRunner({
    start() { return [createEffect('state.transition', { from: '', to: 'stalled' })]; },
    step() { throw new Error('unreachable'); },
    snapshot() { return {}; },
  });
  await assert.rejects(
    () => stalled.start('test', null, {}),
    (error) => error instanceof RunnerProtocolError && /did not yield/.test(error.message),
  );
});
