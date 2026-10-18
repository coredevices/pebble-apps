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

class RunnerProtocolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RunnerProtocolError';
    Object.assign(this, details);
  }
}

function validateBatch(value, source) {
  if (!Array.isArray(value)) {
    throw new RunnerProtocolError(`${source} must return an array of effects`);
  }
  const effects = value.map((effect, index) => {
    validateEffect(effect, `$[${index}]`);
    return cloneJson(effect);
  });

  const yielding = [];
  for (let index = 0; index < effects.length; index += 1) {
    if (isBlockingEffect(effects[index]) || isTerminalEffect(effects[index])) yielding.push(index);
  }
  if (yielding.length === 0) {
    throw new RunnerProtocolError(
      `${source} did not yield a blocking or terminal effect`,
      { effects },
    );
  }
  if (yielding.length > 1) {
    throw new RunnerProtocolError(
      `${source} yielded more than one blocking/terminal effect`,
      { indices: yielding },
    );
  }
  if (yielding[0] !== effects.length - 1) {
    throw new RunnerProtocolError(
      `${source} must put its blocking/terminal effect last`,
      { index: yielding[0] },
    );
  }
  return effects;
}

/**
 * Strict adapter for an in-process JavaScript operation implementation.
 *
 * The wrapped implementation exposes:
 *   start(operation, persistedState, deterministicInputs) -> Effect[]
 *   step(inputEvent) -> Effect[]
 *   snapshot() -> JSON
 *
 * Methods may return either values or Promises. Every argument/result is
 * cloned across the boundary, preventing accidental shared-state agreement in
 * differential tests. The LockstepController accepts this same three-method
 * runner contract, so an LDJSON Rust process can be adapted without subclassing.
 */
class JavaScriptRunner {
  constructor(implementation, { name = 'javascript' } = {}) {
    if (!implementation || typeof implementation !== 'object') {
      throw new TypeError('implementation must be an object');
    }
    for (const method of ['start', 'step', 'snapshot']) {
      if (typeof implementation[method] !== 'function') {
        throw new TypeError(`implementation.${method} must be a function`);
      }
    }
    this.implementation = implementation;
    this.name = name;
    this.started = false;
    this.terminal = false;
    this.pendingEffect = null;
    this.requestIds = new Set();
  }

  async start(operation, persistedState = null, deterministicInputs = {}) {
    if (this.started) throw new RunnerProtocolError(`${this.name} runner already started`);
    if (typeof operation !== 'string' || operation.length === 0) {
      throw new TypeError('operation must be a non-empty string');
    }
    validateJson(persistedState, '$.persistedState');
    validateJson(deterministicInputs, '$.deterministicInputs');
    this.started = true;
    const value = await this.implementation.start(
      operation,
      cloneJson(persistedState),
      cloneJson(deterministicInputs),
    );
    return this.acceptBatch(value, 'start()');
  }

  async step(inputEvent) {
    if (!this.started) throw new RunnerProtocolError(`${this.name} runner has not started`);
    if (this.terminal) throw new RunnerProtocolError(`${this.name} runner is terminal`);
    if (!this.pendingEffect) {
      throw new RunnerProtocolError(`${this.name} runner has no pending effect`);
    }
    validateEvent(inputEvent);
    assertEventRespondsTo(this.pendingEffect, inputEvent);
    this.pendingEffect = null;
    const value = await this.implementation.step(cloneJson(inputEvent));
    return this.acceptBatch(value, 'step()');
  }

  async snapshot() {
    if (!this.started) throw new RunnerProtocolError(`${this.name} runner has not started`);
    const value = await this.implementation.snapshot();
    validateJson(value, '$.snapshot');
    return cloneJson(value);
  }

  acceptBatch(value, source) {
    const effects = validateBatch(value, `${this.name} ${source}`);
    const yieldingEffect = effects[effects.length - 1];
    if (isBlockingEffect(yieldingEffect)) {
      if (this.requestIds.has(yieldingEffect.requestId)) {
        throw new RunnerProtocolError(
          `${this.name} reused requestId ${JSON.stringify(yieldingEffect.requestId)}`,
          { requestId: yieldingEffect.requestId },
        );
      }
      this.requestIds.add(yieldingEffect.requestId);
      this.pendingEffect = yieldingEffect;
    } else {
      this.terminal = true;
    }
    return effects;
  }
}

module.exports = {
  JavaScriptRunner,
  RunnerProtocolError,
  validateBatch,
};
