'use strict';

var RuntimeError = require('./errors').RuntimeError;
var ERROR_KINDS = require('./errors').ERROR_KINDS;

var PROVIDER_METHODS = Object.freeze({
  clock: Object.freeze(['now']),
  random: Object.freeze(['bytes']),
  timer: Object.freeze(['after', 'cancel']),
  crypto: Object.freeze(['request']),
  http: Object.freeze(['request']),
  websocket: Object.freeze(['open', 'send', 'close']),
  tls: Object.freeze(['open', 'write', 'close']),
  storage: Object.freeze(['get', 'set', 'delete']),
  trace: Object.freeze(['emit']),
});

/**
 * Build a protocol-agnostic effects object. Missing capabilities fail when called, which allows
 * pure modules and unit tests to inject only the capabilities they use.
 *
 * @param {{[name: string]: object}=} providers
 * @returns {Readonly<{clock: object, random: object, timer: object, crypto: object, http: object, websocket: object, tls: object, storage: object, trace: object}>}
 */
function createEffects(providers) {
  if (providers === undefined) providers = {};
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new RuntimeError('INVALID_EFFECTS', 'Effects providers must be an object.', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  }

  var unknownNames = Object.keys(providers).filter(function (name) {
    return !Object.prototype.hasOwnProperty.call(PROVIDER_METHODS, name);
  });
  if (unknownNames.length > 0) {
    throw new RuntimeError('INVALID_EFFECTS', 'Unknown effects provider: ' + unknownNames[0] + '.', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  }

  var effects = {};
  Object.keys(PROVIDER_METHODS).forEach(function (providerName) {
    effects[providerName] = createProviderFacade(
      providerName,
      providers[providerName],
      PROVIDER_METHODS[providerName]
    );
  });
  return Object.freeze(effects);
}

/**
 * @param {string} providerName
 * @param {object|undefined} provider
 * @param {ReadonlyArray<string>} methodNames
 * @returns {Readonly<object>}
 */
function createProviderFacade(providerName, provider, methodNames) {
  if (provider !== undefined && (!provider || typeof provider !== 'object')) {
    throw new RuntimeError('INVALID_EFFECTS', providerName + ' effects provider must be an object.', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  }

  var facade = {};
  methodNames.forEach(function (methodName) {
    facade[methodName] = function () {
      if (!provider || typeof provider[methodName] !== 'function') {
        if (!provider && providerName === 'trace' && methodName === 'emit') return undefined;
        throw new RuntimeError(
          'MISSING_EFFECT',
          'Missing effects capability ' + providerName + '.' + methodName + '.',
          { kind: ERROR_KINDS.CAPABILITY }
        );
      }

      var args = Array.prototype.slice.call(arguments);
      validateEffectArguments(providerName, methodName, args);
      var result = provider[methodName].apply(provider, args);
      return validateEffectResult(providerName, methodName, args, result);
    };
  });
  return Object.freeze(facade);
}

/**
 * @param {string} providerName
 * @param {string} methodName
 * @param {Array<unknown>} args
 */
function validateEffectArguments(providerName, methodName, args) {
  if (providerName === 'random' && methodName === 'bytes') {
    var length = args[0];
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RuntimeError('INVALID_ARGUMENT', 'Random byte length must be a non-negative safe integer.', {
        kind: ERROR_KINDS.INVALID_INPUT,
      });
    }
  }
}

/**
 * @param {string} providerName
 * @param {string} methodName
 * @param {Array<unknown>} args
 * @param {unknown} result
 * @returns {unknown}
 */
function validateEffectResult(providerName, methodName, args, result) {
  if (providerName === 'clock' && methodName === 'now') {
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      throw invalidEffectResult('clock.now must return a finite number.');
    }
  }

  if (providerName === 'random' && methodName === 'bytes') {
    var length = args[0];
    if (!(result instanceof Uint8Array) || result.length !== length) {
      throw invalidEffectResult('random.bytes must return a Uint8Array of the requested length.');
    }
    return new Uint8Array(result);
  }

  return result;
}

/** @param {string} message @returns {RuntimeError} */
function invalidEffectResult(message) {
  return new RuntimeError('INVALID_EFFECT_RESULT', message, { kind: ERROR_KINDS.INTERNAL });
}

module.exports = {
  PROVIDER_METHODS: PROVIDER_METHODS,
  createEffects: createEffects,
};
