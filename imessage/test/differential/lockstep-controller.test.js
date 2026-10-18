'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DeterministicResolver,
  JavaScriptRunner,
  LockstepController,
  LockstepDivergenceError,
  byteString,
  createEffect,
  decodeByteString,
  semanticComparator,
} = require('../../harness');

class FragmentedTlsOperation {
  constructor({ divergentWrite = false } = {}) {
    this.phase = 'new';
    this.received = [];
    this.readIndex = 0;
    this.divergentWrite = divergentWrite;
  }

  start() {
    this.phase = 'opening';
    return [
      createEffect('state.transition', { from: 'new', to: 'opening' }),
      createEffect('tls.open', {
        requestId: 'open-1',
        streamId: 'fixture-tls',
        host: 'fixture.invalid',
        port: 443,
        alpn: ['fixture-v1'],
      }),
    ];
  }

  step(event) {
    if (event.kind === 'tls.opened') {
      this.phase = 'writing';
      return [
        createEffect('state.transition', { from: 'opening', to: 'writing' }),
        createEffect('tls.write', {
          requestId: 'write-1',
          streamId: 'fixture-tls',
          data: byteString(this.divergentWrite ? [0x10, 0x20, 0x31] : [0x10, 0x20, 0x30]),
        }),
      ];
    }
    if (event.kind === 'tls.written' || event.kind === 'tls.data') {
      if (event.kind === 'tls.data') this.received.push(...decodeByteString(event.data));
      if (this.received.length < 5) {
        this.phase = 'reading';
        this.readIndex += 1;
        return [createEffect('tls.read', {
          requestId: `read-${this.readIndex}`,
          streamId: 'fixture-tls',
          maximumBytes: 5,
        })];
      }
      this.phase = 'done';
      return [
        createEffect('state.transition', { from: 'reading', to: 'done' }),
        createEffect('terminal.result', { result: { data: byteString(this.received) } }),
      ];
    }
    throw new Error(`Unexpected event ${event.kind}`);
  }

  snapshot() {
    return { phase: this.phase, received: byteString(this.received) };
  }
}

function fragmentedResolver() {
  return new DeterministicResolver({
    script: [
      {
        effectKind: 'tls.open',
        event: {
          kind: 'tls.opened',
          streamId: 'fixture-tls',
          negotiatedAlpn: 'fixture-v1',
        },
      },
      (effect) => ({
        kind: 'tls.written',
        requestId: effect.requestId,
        streamId: effect.streamId,
        length: decodeByteString(effect.data).length,
      }),
      ...[[1, 2], [3], [4, 5]].map((chunk) => (effect) => ({
        kind: 'tls.data',
        requestId: effect.requestId,
        streamId: effect.streamId,
        data: byteString(chunk),
      })),
    ],
  });
}

test('lockstep uses one resolver and feeds the same fragmented TLS events to both runners', async () => {
  const resolver = fragmentedResolver();
  let resolutions = 0;
  const controller = new LockstepController({
    left: new JavaScriptRunner(new FragmentedTlsOperation(), { name: 'left' }),
    right: new JavaScriptRunner(new FragmentedTlsOperation(), { name: 'right' }),
    resolveEffect: async (effect, context) => {
      resolutions += 1;
      return resolver.resolveEffect(effect, context);
    },
  });
  const result = await controller.run('fragmented-tls', null, { fixture: 'fragmented-v1' });
  resolver.assertExhausted();

  assert.equal(resolutions, 5);
  assert.equal(result.terminal.kind, 'terminal.result');
  assert.deepEqual(decodeByteString(result.terminal.result.data), Uint8Array.of(1, 2, 3, 4, 5));
  assert.deepEqual(result.snapshot, {
    phase: 'done',
    received: byteString([1, 2, 3, 4, 5]),
  });
  assert.equal(result.trace.filter((entry) => entry.type === 'event').length, 5);
});

test('one-byte divergence reports the exact global effect, path, and byte offset', async () => {
  const resolver = fragmentedResolver();
  const controller = new LockstepController({
    left: new JavaScriptRunner(new FragmentedTlsOperation()),
    right: new JavaScriptRunner(new FragmentedTlsOperation({ divergentWrite: true })),
    resolveEffect: resolver.resolveEffect,
  });

  await assert.rejects(() => controller.run('fragmented-tls'), (error) => {
    assert.equal(error instanceof LockstepDivergenceError, true);
    assert.equal(error.phase, 'effect');
    assert.equal(error.effectIndex, 3);
    assert.equal(error.path, '$.data');
    assert.equal(error.byteOffset, 2);
    assert.match(error.message, /effect 3/);
    return true;
  });
});

test('per-kind semantic comparator can accept randomized but equivalent terminal data', async () => {
  function implementation(signature) {
    return {
      start() {
        return [createEffect('terminal.result', {
          result: { digest: 'same-digest', randomizedSignature: signature },
        })];
      },
      step() { throw new Error('unreachable'); },
      snapshot() { return { committed: true }; },
    };
  }
  const controller = new LockstepController({
    left: new JavaScriptRunner(implementation('signature-one')),
    right: new JavaScriptRunner(implementation('signature-two')),
    resolveEffect() { throw new Error('unreachable'); },
    comparators: {
      'terminal.result': semanticComparator(
        (left, right) => left.result.digest === right.result.digest,
        'decoded digest differs',
      ),
    },
  });
  const result = await controller.run('semantic-signature');
  assert.equal(result.terminal.result.digest, 'same-digest');
});

test('snapshot divergence reports its first canonical state path', async () => {
  function implementation(counter) {
    return {
      start() { return [createEffect('terminal.result', { result: { ok: true } })]; },
      step() { throw new Error('unreachable'); },
      snapshot() { return { session: { counter } }; },
    };
  }
  const controller = new LockstepController({
    left: new JavaScriptRunner(implementation(4)),
    right: new JavaScriptRunner(implementation(5)),
    resolveEffect() { throw new Error('unreachable'); },
  });
  await assert.rejects(() => controller.run('snapshot-divergence'), (error) => {
    assert.equal(error.phase, 'snapshot');
    assert.equal(error.path, '$.session.counter');
    return true;
  });
});

test('deterministic resolver supplies reproducible random and clock inputs', async () => {
  async function collect(seed) {
    const resolver = new DeterministicResolver({ seed, nowMs: 5000, clockStepMs: 7 });
    const random = await resolver.resolveEffect(createEffect('random.request', {
      requestId: 'random',
      length: 8,
    }));
    const firstClock = await resolver.resolveEffect(createEffect('clock.read', { requestId: 'clock-1' }));
    const secondClock = await resolver.resolveEffect(createEffect('clock.read', { requestId: 'clock-2' }));
    return { random: random.data, times: [firstClock.nowMs, secondClock.nowMs] };
  }
  assert.deepEqual(await collect(42), await collect(42));
  assert.notDeepEqual((await collect(42)).random, (await collect(43)).random);
  assert.deepEqual((await collect(42)).times, [5000, 5007]);
});
