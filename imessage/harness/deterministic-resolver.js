'use strict';

const {
  SCHEMA_VERSION,
  assertEventRespondsTo,
  byteString,
  cloneJson,
  createEvent,
  decodeByteString,
  validateEvent,
} = require('./schema');

class DeterministicResolverError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DeterministicResolverError';
    Object.assign(this, details);
  }
}

/**
 * Test-only resolver for deterministic clock, timer, and random-byte effects.
 * The xorshift generator is reproducible, not cryptographically secure.
 * Network, crypto, and storage effects must be supplied as ordered script
 * entries, preventing accidental ambient traffic from a harness test.
 */
class DeterministicResolver {
  constructor({
    seed = 0x6d2b79f5,
    nowMs = 1700000000000,
    clockStepMs = 1,
    randomBytes,
    script = [],
  } = {}) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new TypeError('seed must be an unsigned 32-bit integer');
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('nowMs must be non-negative');
    if (!Number.isSafeInteger(clockStepMs) || clockStepMs < 0) {
      throw new TypeError('clockStepMs must be non-negative');
    }
    if (!Array.isArray(script)) throw new TypeError('script must be an array');

    this.state = seed === 0 ? 0x6d2b79f5 : seed >>> 0;
    this.nowMs = nowMs;
    this.clockStepMs = clockStepMs;
    this.script = script.slice();
    this.scriptOffset = 0;
    this.suppliedRandom = randomBytes === undefined
      ? null
      : decodeByteString(randomBytes);
    this.randomOffset = 0;
    this.resolveEffect = this.resolveEffect.bind(this);
  }

  nextUint32() {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  takeRandom(length) {
    if (this.suppliedRandom !== null) {
      if (this.randomOffset + length > this.suppliedRandom.length) {
        throw new DeterministicResolverError('Supplied random byte fixture is exhausted', {
          requested: length,
          remaining: this.suppliedRandom.length - this.randomOffset,
        });
      }
      const result = this.suppliedRandom.slice(this.randomOffset, this.randomOffset + length);
      this.randomOffset += length;
      return result;
    }
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) result[index] = this.nextUint32() & 0xff;
    return result;
  }

  async resolveEffect(effect, context) {
    let event;
    switch (effect.kind) {
      case 'random.request':
        event = createEvent('random.result', {
          requestId: effect.requestId,
          data: byteString(this.takeRandom(effect.length)),
        });
        break;
      case 'clock.read': {
        const read = this.nowMs;
        this.nowMs += this.clockStepMs;
        event = createEvent('clock.result', { requestId: effect.requestId, nowMs: read });
        break;
      }
      case 'timer.schedule':
        this.nowMs = Math.max(this.nowMs, effect.deadlineMs);
        event = createEvent('timer.fired', {
          requestId: effect.requestId,
          nowMs: this.nowMs,
        });
        break;
      default:
        event = await this.takeScriptedEvent(effect, context);
        break;
    }
    validateEvent(event);
    assertEventRespondsTo(effect, event);
    return cloneJson(event);
  }

  async takeScriptedEvent(effect, context) {
    if (this.scriptOffset >= this.script.length) {
      throw new DeterministicResolverError(
        `No scripted response for ${effect.kind}`,
        { effectKind: effect.kind, scriptOffset: this.scriptOffset },
      );
    }
    const index = this.scriptOffset;
    const entry = this.script[this.scriptOffset++];
    let value;
    if (typeof entry === 'function') {
      value = await entry(cloneJson(effect), context);
    } else {
      if (!entry || typeof entry !== 'object') {
        throw new DeterministicResolverError(`Invalid script entry ${index}`);
      }
      if (entry.effectKind !== undefined && entry.effectKind !== effect.kind) {
        throw new DeterministicResolverError(
          `Script entry ${index} expected ${entry.effectKind}, got ${effect.kind}`,
          { scriptOffset: index, expected: entry.effectKind, actual: effect.kind },
        );
      }
      value = entry.event === undefined ? entry : entry.event;
    }
    if (!value || typeof value !== 'object') {
      throw new DeterministicResolverError(`Script entry ${index} did not return an event`);
    }
    const normalized = { ...value };
    normalized.version = value.version === undefined ? SCHEMA_VERSION : value.version;
    normalized.requestId = value.requestId === undefined ? effect.requestId : value.requestId;
    return normalized;
  }

  assertExhausted() {
    if (this.scriptOffset !== this.script.length) {
      throw new DeterministicResolverError(
        `${this.script.length - this.scriptOffset} scripted responses were not consumed`,
        { scriptOffset: this.scriptOffset, scriptLength: this.script.length },
      );
    }
    if (this.suppliedRandom !== null && this.randomOffset !== this.suppliedRandom.length) {
      throw new DeterministicResolverError(
        `${this.suppliedRandom.length - this.randomOffset} supplied random bytes were not consumed`,
      );
    }
  }

  snapshot() {
    return {
      nowMs: this.nowMs,
      randomState: this.state,
      randomOffset: this.randomOffset,
      scriptOffset: this.scriptOffset,
    };
  }
}

module.exports = {
  DeterministicResolver,
  DeterministicResolverError,
};
