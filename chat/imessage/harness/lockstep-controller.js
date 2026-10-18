'use strict';

const {
  assertEventRespondsTo,
  cloneJson,
  isBlockingEffect,
  isTerminalEffect,
  validateEffect,
  validateEvent,
  validateJson,
} = require('./schema');
const {
  compareEffects,
  compareSnapshots,
} = require('./comparator');

class LockstepDivergenceError extends Error {
  constructor({ phase, turn, effectIndex, batchIndex, comparison, kind }) {
    const byte = comparison.byteOffset === undefined
      ? ''
      : `, byte offset ${comparison.byteOffset}`;
    const location = phase === 'snapshot'
      ? `snapshot after turn ${turn}`
      : `effect ${effectIndex} (turn ${turn}, batch index ${batchIndex})`;
    super(`Lockstep divergence at ${location}, ${comparison.path}${byte}: ${comparison.reason}`);
    this.name = 'LockstepDivergenceError';
    this.phase = phase;
    this.turn = turn;
    this.effectIndex = effectIndex;
    this.batchIndex = batchIndex;
    this.path = comparison.path;
    this.reason = comparison.reason;
    this.kind = kind;
    if (comparison.byteOffset !== undefined) this.byteOffset = comparison.byteOffset;
  }
}

class LockstepProtocolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LockstepProtocolError';
    Object.assign(this, details);
  }
}

function assertRunner(runner, name) {
  if (!runner || typeof runner !== 'object') throw new TypeError(`${name} must be a runner object`);
  for (const method of ['start', 'step', 'snapshot']) {
    if (typeof runner[method] !== 'function') {
      throw new TypeError(`${name}.${method} must be a function`);
    }
  }
}

function makeLengthComparison(leftLength, rightLength, index) {
  return {
    equal: false,
    path: `$[${index}]`,
    reason: `effect batch length differs (${leftLength} !== ${rightLength})`,
  };
}

/**
 * Drives two operation runners with one sequence of input events.
 *
 * `resolveEffect(effect, context)` owns all I/O and must return one common
 * event. This is the single-writer guarantee: the controller never calls a
 * resolver twice for the same matched pair. Runners may be in-process JS,
 * LDJSON subprocess adapters, or any object implementing start/step/snapshot.
 */
class LockstepController {
  constructor({
    left,
    right,
    resolveEffect,
    comparators,
    snapshotComparator,
    compareState = 'each-turn',
    maxTurns = 1000,
    maxEffects = 10000,
  }) {
    assertRunner(left, 'left');
    assertRunner(right, 'right');
    if (typeof resolveEffect !== 'function') {
      throw new TypeError('resolveEffect must be a function');
    }
    if (compareState !== 'each-turn' && compareState !== 'terminal' && compareState !== false) {
      throw new TypeError('compareState must be each-turn, terminal, or false');
    }
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 0) throw new TypeError('maxTurns must be non-negative');
    if (!Number.isSafeInteger(maxEffects) || maxEffects < 1) throw new TypeError('maxEffects must be positive');

    this.left = left;
    this.right = right;
    this.resolveEffect = resolveEffect;
    this.comparators = comparators;
    this.snapshotComparator = snapshotComparator;
    this.compareState = compareState;
    this.maxTurns = maxTurns;
    this.maxEffects = maxEffects;
  }

  async run(operation, persistedState = null, deterministicInputs = {}) {
    const trace = [];
    let turn = 0;
    let effectIndex = 0;
    let batches = await Promise.all([
      this.left.start(operation, cloneJson(persistedState), cloneJson(deterministicInputs)),
      this.right.start(operation, cloneJson(persistedState), cloneJson(deterministicInputs)),
    ]);

    for (;;) {
      const [leftEffects, rightEffects] = batches;
      if (!Array.isArray(leftEffects) || !Array.isArray(rightEffects)) {
        throw new LockstepProtocolError('Runner returned a non-array effect batch', { turn });
      }
      leftEffects.forEach((effect, index) => validateEffect(effect, `$.left[${index}]`));
      rightEffects.forEach((effect, index) => validateEffect(effect, `$.right[${index}]`));

      const sharedLength = Math.min(leftEffects.length, rightEffects.length);
      for (let batchIndex = 0; batchIndex < sharedLength; batchIndex += 1) {
        if (effectIndex + batchIndex >= this.maxEffects) {
          throw new LockstepProtocolError(`Exceeded maxEffects (${this.maxEffects})`, { turn });
        }
        const leftEffect = leftEffects[batchIndex];
        const rightEffect = rightEffects[batchIndex];
        const comparison = compareEffects(leftEffect, rightEffect, {
          comparators: this.comparators,
          effectIndex: effectIndex + batchIndex,
          turn,
        });
        if (!comparison.equal) {
          throw new LockstepDivergenceError({
            phase: 'effect',
            turn,
            effectIndex: effectIndex + batchIndex,
            batchIndex,
            comparison,
            kind: leftEffect.kind === rightEffect.kind ? leftEffect.kind : undefined,
          });
        }
        trace.push({
          type: 'effect',
          turn,
          effectIndex: effectIndex + batchIndex,
          value: cloneJson(leftEffect),
        });
      }

      if (leftEffects.length !== rightEffects.length) {
        const comparison = makeLengthComparison(leftEffects.length, rightEffects.length, sharedLength);
        throw new LockstepDivergenceError({
          phase: 'effect',
          turn,
          effectIndex: effectIndex + sharedLength,
          batchIndex: sharedLength,
          comparison,
        });
      }
      if (leftEffects.length === 0) {
        throw new LockstepProtocolError('Runner yielded an empty effect batch', { turn });
      }

      const lastEffect = leftEffects[leftEffects.length - 1];
      const terminal = isTerminalEffect(lastEffect);
      if (!terminal && !isBlockingEffect(lastEffect)) {
        throw new LockstepProtocolError(
          'Effect batch must end in a blocking or terminal effect',
          { turn, kind: lastEffect.kind },
        );
      }
      effectIndex += leftEffects.length;

      let matchedSnapshot;
      if (this.compareState === 'each-turn' || (this.compareState === 'terminal' && terminal)) {
        matchedSnapshot = await this.assertSnapshots(turn, effectIndex);
      }

      if (terminal) {
        if (matchedSnapshot === undefined) {
          matchedSnapshot = await this.left.snapshot();
          validateJson(matchedSnapshot, '$.snapshot');
          matchedSnapshot = cloneJson(matchedSnapshot);
        }
        return {
          terminal: cloneJson(lastEffect),
          snapshot: matchedSnapshot,
          trace,
          turns: turn,
          effects: effectIndex,
        };
      }

      if (turn >= this.maxTurns) {
        throw new LockstepProtocolError(`Exceeded maxTurns (${this.maxTurns})`, { turn });
      }
      const inputEvent = await this.resolveEffect(cloneJson(lastEffect), Object.freeze({
        operation,
        turn,
        effectIndex: effectIndex - 1,
        trace: trace.slice(),
      }));
      validateEvent(inputEvent);
      assertEventRespondsTo(lastEffect, inputEvent);
      trace.push({ type: 'event', turn, value: cloneJson(inputEvent) });

      batches = await Promise.all([
        this.left.step(cloneJson(inputEvent)),
        this.right.step(cloneJson(inputEvent)),
      ]);
      turn += 1;
    }
  }

  async assertSnapshots(turn, effectIndex) {
    const [leftSnapshot, rightSnapshot] = await Promise.all([
      this.left.snapshot(),
      this.right.snapshot(),
    ]);
    const comparison = compareSnapshots(
      leftSnapshot,
      rightSnapshot,
      this.snapshotComparator,
      { turn, effectIndex },
    );
    if (!comparison.equal) {
      throw new LockstepDivergenceError({
        phase: 'snapshot',
        turn,
        effectIndex,
        comparison,
      });
    }
    return cloneJson(leftSnapshot);
  }
}

module.exports = {
  LockstepController,
  LockstepDivergenceError,
  LockstepProtocolError,
};
