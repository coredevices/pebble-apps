'use strict';

var ERROR_KINDS = Object.freeze({
  INVALID_INPUT: 'invalid-input',
  CAPABILITY: 'capability',
  TRANSPORT: 'transport',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  STORAGE: 'storage',
  CRYPTO: 'crypto',
  INTERNAL: 'internal',
});

/**
 * An error whose public fields can cross the plugin/host and harness boundaries.
 */
class RuntimeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{kind?: string, retryable?: boolean, details?: unknown, cause?: unknown}=} options
   */
  constructor(code, message, options) {
    if (typeof code !== 'string' || code.length === 0) {
      throw new TypeError('RuntimeError code must be a non-empty string.');
    }
    if (typeof message !== 'string' || message.length === 0) {
      throw new TypeError('RuntimeError message must be a non-empty string.');
    }

    super(message);
    options = options || {};

    this.name = 'RuntimeError';
    this.code = code;
    this.kind = options.kind || ERROR_KINDS.INTERNAL;
    this.retryable = options.retryable === true;

    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: options.cause,
        writable: true,
      });
    }
  }

  /** @returns {{name: string, code: string, message: string, kind: string, retryable: boolean, details?: unknown}} */
  toJSON() {
    var result = {
      name: this.name,
      code: this.code,
      message: this.message,
      kind: this.kind,
      retryable: this.retryable,
    };
    if (this.details !== undefined) {
      result.details = this.details;
    }
    return result;
  }
}

/**
 * @param {unknown} value
 * @returns {value is RuntimeError}
 */
function isRuntimeError(value) {
  return value instanceof RuntimeError;
}

/**
 * Preserve structured errors and wrap all other thrown values without exposing their message.
 *
 * @param {unknown} value
 * @param {string} fallbackCode
 * @param {string} fallbackMessage
 * @param {{kind?: string, retryable?: boolean, details?: unknown}=} options
 * @returns {RuntimeError}
 */
function asRuntimeError(value, fallbackCode, fallbackMessage, options) {
  if (isRuntimeError(value)) {
    return value;
  }

  var wrappedOptions = Object.assign({}, options || {}, { cause: value });
  return new RuntimeError(fallbackCode, fallbackMessage, wrappedOptions);
}

/**
 * Restore a RuntimeError from a trusted, already-parsed boundary value.
 *
 * @param {unknown} value
 * @returns {RuntimeError}
 */
function deserializeRuntimeError(value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Serialized runtime error must be an object.');
  }

  var serialized = /** @type {{code?: unknown, message?: unknown, kind?: unknown, retryable?: unknown, details?: unknown}} */ (value);
  if (typeof serialized.code !== 'string' || typeof serialized.message !== 'string') {
    throw new TypeError('Serialized runtime error is missing its code or message.');
  }
  if (serialized.kind !== undefined && typeof serialized.kind !== 'string') {
    throw new TypeError('Serialized runtime error kind must be a string.');
  }
  if (serialized.retryable !== undefined && typeof serialized.retryable !== 'boolean') {
    throw new TypeError('Serialized runtime error retryable flag must be boolean.');
  }

  return new RuntimeError(serialized.code, serialized.message, {
    kind: serialized.kind,
    retryable: serialized.retryable,
    details: serialized.details,
  });
}

module.exports = {
  ERROR_KINDS: ERROR_KINDS,
  RuntimeError: RuntimeError,
  asRuntimeError: asRuntimeError,
  deserializeRuntimeError: deserializeRuntimeError,
  isRuntimeError: isRuntimeError,
};
