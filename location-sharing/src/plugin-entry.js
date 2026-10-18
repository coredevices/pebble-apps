'use strict';
// var remoteAnisette = require('../../chat/imessage/src/anisette/remote-v3');
// var RemoteV3ProvisioningRunner = require('../../chat/imessage/src/anisette/remote-v3-runner').RemoteV3ProvisioningRunner;
// var ConfigurationCoordinator = require('./configuration/coordinator').ConfigurationCoordinator;
// var CryptoCompositions = require('../../chat/imessage/src/crypto/compositions').CryptoCompositions;
// var FindMyFriendsClient = require('./findmy/client').FindMyFriendsClient;
var GoogleMapsClient = require('./google/client').GoogleMapsClient;
var LocationSharingController = require('./location-sharing/controller').LocationSharingController;
// var idsBag = require('../../chat/imessage/src/ids/bag');
// var validationData = require('../../chat/imessage/src/nac/validation-data');
// var bytes = require('../../chat/imessage/src/runtime/bytes');
var createEffects = require('../../chat/imessage/src/runtime/effects').createEffects;
// var NativeHostCryptoProvider = require('../../chat/imessage/src/runtime/host-crypto-provider').NativeHostCryptoProvider;
// var WasmHostX86Provider = require('../../chat/imessage/src/runtime/wasm-x86-provider').WasmHostX86Provider;
var hostEnvironment = require('../../chat/imessage/src/runtime/host-environment');
// var HostTimer = require('../../chat/imessage/src/runtime/host-timer-provider').HostTimer;
// var HostTlsSocket = require('../../chat/imessage/src/runtime/host-tls-socket-provider').HostTlsSocket;
// var TlsRoutingHttpProvider = require('../../chat/imessage/src/runtime/tls-http-provider').TlsRoutingHttpProvider;
// var DurableStateRepository = require('./state/durable-state-repository').DurableStateRepository;
var FetchHttpProvider = require('./runtime/fetch-http-provider').FetchHttpProvider;
// var JsHostCrypto = require('./runtime/js-host-crypto').JsHostCrypto;
var SecureBlobStorage = require('./runtime/secure-blob-storage').SecureBlobStorage;
// var StandardWebSocket = require('./runtime/standard-websocket-provider').StandardWebSocket;
// Apple Find My needs host features stock CoreApp doesn't give plugins (raw TLS sockets, saved
// Mac keys, host crypto, timers), so it is switched off below and only Google Maps runs.
var APPLE_UNAVAILABLE = 'Apple Find My is not available in this version.';
function appleUnavailable() {
  var error = new Error(APPLE_UNAVAILABLE);
  error.code = 'PLUGIN_UNAVAILABLE';
  throw error;
}
var disabledAppleConfiguration = Object.freeze({
  status: function() { return { phase: 'disabled', ready: false, canSubmitTwoFactor: false }; },
  validateConfigurationInput: appleUnavailable,
  configure: async function() { appleUnavailable(); },
  submitTwoFactor: async function() { appleUnavailable(); },
  disconnect: async function() { return disabledAppleConfiguration.status(); },
});
var disabledAppleClient = Object.freeze({
  cached: function() { return []; },
  refresh: async function() { return []; },
});

// Stock CoreApp has no plugin timers, so request deadlines never fire and the host's action limit
// applies instead.
function noTimer() {
  var next = 0;
  return Object.freeze({ after: function() { return ++next; }, cancel: function() {} });
}

// Only an Android device id is random here; Web Crypto where the engine has it, else Math.random.
var randomProvider = Object.freeze({
  bytes: function(length) {
    var out = new Uint8Array(length);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) return crypto.getRandomValues(out);
    for (var i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }
});

// The phone's position, or null when location is off or the permission is refused.
function currentPosition(globalObject) {
  var geolocation = globalObject.navigator && globalObject.navigator.geolocation;
  if (!geolocation) return Promise.resolve(null);
  return new Promise(function(resolve) {
    geolocation.getCurrentPosition(function(position) {
      resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude });
    }, function() { resolve(null); }, { maximumAge: 60000, timeout: 8000, enableHighAccuracy: false });
  });
}

function createProductionController(globalObject, storage) {
  var timer = noTimer();
  var effects = createEffects({
    clock: hostEnvironment.createClockProvider(),
    timer,
    random: randomProvider,
    http: new FetchHttpProvider(globalObject.fetch, timer),
    storage: new hostEnvironment.LocalStorageProvider(storage),
    trace: hostEnvironment.createTraceProvider(globalObject.console)
  });
  return new LocationSharingController({
    appleConfiguration: disabledAppleConfiguration,
    appleClient: disabledAppleClient,
    googleClient: new GoogleMapsClient({ effects }),
    http: effects.http,
    storage: effects.storage,
    currentPosition: function() { return currentPosition(globalObject); },
    prepareAppleConfiguration: async function() {},
    now: function() {
      return effects.clock.now();
    }
  });
}

// The Apple Find My controller, for when the host gives plugins TLS sockets and Mac keys again.
// function createAppleAndGoogleController(globalObject, storage) {
//   var crypto = new CryptoCompositions(new NativeHostCryptoProvider(
//     new JsHostCrypto(globalObject._HostCrypto, storage)));
//   var timer = new HostTimer(globalObject._HostTimer, globalObject);
//   var tls = new HostTlsSocket(globalObject._HostTlsSocket, globalObject);
//   var fetchHttp = new FetchHttpProvider(globalObject.fetch, timer);
//   var trace = hostEnvironment.createTraceProvider(globalObject.console);
//   var effects = createEffects({
//     clock: hostEnvironment.createClockProvider(),
//     timer,
//     random: hostEnvironment.createRandomProvider(crypto),
//     crypto: { request: function(effect) {
//       return crypto.provider.request(effect);
//     } },
//     http: new TlsRoutingHttpProvider(fetchHttp, tls, timer, function(kind) {
//       trace.emit(Object.freeze({ kind }));
//     }),
//     websocket: new StandardWebSocket(globalObject.WebSocket),
//     tls,
//     storage: new hostEnvironment.LocalStorageProvider(storage),
//     trace
//   });
//   var repository = new DurableStateRepository(effects);
//   var mutableConfig = {
//     anisette: { remoteUrl: remoteAnisette.DEFAULT_REMOTE_URL },
//     push: {},
//     ids: {}
//   };
//   var configuration = new ConfigurationCoordinator({
//     effects,
//     crypto,
//     repository,
//     config: mutableConfig,
//     anisetteRunner: new RemoteV3ProvisioningRunner({ effects })
//   });
//   function createFreshValidationDataGenerator(endpoints) {
//     return validationData.createValidationDataGenerator({
//       effects,
//       crypto,
//       machineProvider: new WasmHostX86Provider({ randomBytes: function(size) { return crypto.random(size); } }),
//       workerProvider: null,
//       randomWord: function() {
//         return bytes.readUint32LE(effects.random.bytes(4));
//       },
//       endpoints
//     });
//   }
//   async function prepareConfiguration() {
//     effects.trace.emit(Object.freeze({ kind: "configuration.ids-bag-start" }));
//     mutableConfig.ids = await idsBag.fetchIdsEndpoints(effects);
//     configuration.setValidationDataGenerator(createFreshValidationDataGenerator(mutableConfig.ids));
//     effects.trace.emit(Object.freeze({ kind: "configuration.ids-bag-complete" }));
//   }
//   var appleClient = new FindMyFriendsClient({ effects, configuration });
//   var googleClient = new GoogleMapsClient({ effects });
//   return new LocationSharingController({
//     appleConfiguration: configuration,
//     appleClient,
//     googleClient,
//     prepareAppleConfiguration: prepareConfiguration,
//     now: function() {
//       return effects.clock.now();
//     }
//   });
// }

var storage = new SecureBlobStorage(Pebble.secureStorage, 'location-sharing.state.v1');
var controllerReady = storage.loaded.then(function() {
  return createProductionController(globalThis, storage);
});
var SAVE_FAILED = 'Could not save Location Sharing settings. Try again.';
function afterFlush(fn, onFailure) {
  return function() {
    var args = arguments;
    return storage.flush().then(function() { return fn.apply(null, args); }, function() { return onFailure(args); });
  };
}
function sameArgs(fn) { return function(args) { return fn.apply(null, args); }; }
Pebble.registerSourceHandler(function(request, respond) {
  return controllerReady.then(function(controller) {
    return controller.handleSource(request, {
      data: afterFlush(respond.data, function() { return respond.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); }),
      error: afterFlush(respond.error, sameArgs(respond.error)),
    });
  });
});
Pebble.registerActionHandler(function(request, respond) {
  return controllerReady.then(function(controller) {
    return controller.handleAction(request, {
      ok: afterFlush(respond.ok, function() { return respond.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); }),
      error: afterFlush(respond.error, sameArgs(respond.error)),
    });
  });
});
Pebble.registerConfigHandler(function(message, respond) {
  return controllerReady.then(function(controller) {
    return controller.handleConfig(message).then(afterFlush(respond, function() { return respond({ ok: false, error: SAVE_FAILED }); }));
  });
});
module.exports = { createProductionController };
