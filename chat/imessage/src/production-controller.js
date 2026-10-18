'use strict';

var remoteAnisette = require('./anisette/remote-v3');
var RemoteV3ProvisioningRunner = require('./anisette/remote-v3-runner').RemoteV3ProvisioningRunner;
var ConfigurationCoordinator = require('./configuration/coordinator').ConfigurationCoordinator;
var CryptoCompositions = require('./crypto/compositions').CryptoCompositions;
var idsBag = require('./ids/bag');
var validationData = require('./nac/validation-data');
var SendCoordinator = require('./imessage/send-coordinator').SendCoordinator;
var PluginController = require('./plugin-controller').PluginController;
var bytes = require('./runtime/bytes');
var createEffects = require('./runtime/effects').createEffects;
var NativeHostCryptoProvider = require('./runtime/host-crypto-provider').NativeHostCryptoProvider;
var WasmHostX86Provider = require('./runtime/wasm-x86-provider').WasmHostX86Provider;
var hostEnvironment = require('./runtime/host-environment');
var HostTimer = require('./runtime/host-timer-provider').HostTimer;
var HostJsWorker = require('./runtime/host-js-worker').HostJsWorker;
var HostTlsSocket = require('./runtime/host-tls-socket-provider').HostTlsSocket;
var HostWebSocket = require('./runtime/host-websocket-provider').HostWebSocket;
var TlsRoutingHttpProvider = require('./runtime/tls-http-provider').TlsRoutingHttpProvider;
var DurableStateRepository = require('./state/durable-state-repository').DurableStateRepository;
var UserPreferences = require('./preferences/user-preferences').UserPreferences;

function createProductionController(globalObject) {
  var crypto = new CryptoCompositions(new NativeHostCryptoProvider(globalObject._HostCrypto));
  var timer = new HostTimer(globalObject._HostTimer, globalObject);
  var workerProvider = globalObject._HostJsWorker ? new HostJsWorker(globalObject._HostJsWorker, timer, globalObject) : null;
  var tls = new HostTlsSocket(globalObject._HostTlsSocket, globalObject);
  var xhr = new hostEnvironment.XhrHttpProvider(globalObject.XMLHttpRequest, timer);
  var trace = hostEnvironment.createTraceProvider(globalObject.console);
  var effects = createEffects({
    clock: hostEnvironment.createClockProvider(),
    timer: timer,
    random: hostEnvironment.createRandomProvider(crypto),
    crypto: { request: function (effect) { return crypto.provider.request(effect); } },
    http: new TlsRoutingHttpProvider(xhr, tls, timer, function (kind) {
      trace.emit(Object.freeze({ kind: kind }));
    }),
    websocket: new HostWebSocket(globalObject._HostWebSocket, globalObject),
    tls: tls,
    storage: new hostEnvironment.LocalStorageProvider(globalObject.localStorage),
    trace: trace,
  });
  var repository = new DurableStateRepository(effects);
  var preferences = new UserPreferences(effects.storage);
  var mutableConfig = {
    anisette: { remoteUrl: remoteAnisette.DEFAULT_REMOTE_URL },
    push: {},
    ids: {},
  };
  var anisetteRunner = new RemoteV3ProvisioningRunner({ effects: effects });
  var configuration = new ConfigurationCoordinator({
    effects: effects,
    crypto: crypto,
    repository: repository,
    config: mutableConfig,
    anisetteRunner: anisetteRunner,
  });

  function createFreshValidationDataGenerator(endpoints) {
    // Construct the bundled Wasm interpreter only after JS has discovered and validated the full
    // IDS endpoint set. The executor remains protocol-neutral; all NAC and Apple behavior stays JS.
    var machineProvider = new WasmHostX86Provider({ randomBytes: function (size) { return crypto.random(size); } });
    return validationData.createValidationDataGenerator({
      effects: effects,
      crypto: crypto,
      machineProvider: machineProvider,
      workerProvider: workerProvider,
      randomWord: function () { return bytes.readUint32LE(effects.random.bytes(4)); },
      endpoints: endpoints,
    });
  }

  return new PluginController({
    configuration: configuration,
    preferences: preferences,
    prepareConfiguration: async function () {
      effects.trace.emit(Object.freeze({ kind: 'configuration.ids-bag-start' }));
      mutableConfig.ids = await idsBag.fetchIdsEndpoints(effects);
      configuration.setValidationDataGenerator(
        createFreshValidationDataGenerator(mutableConfig.ids)
      );
      effects.trace.emit(Object.freeze({ kind: 'configuration.ids-bag-complete' }));
    },
    createSender: async function (options) {
      return new SendCoordinator({
        effects: effects,
        crypto: crypto,
        repository: repository,
        sender: options.sender,
        validationDataGeneratorFactory: createFreshValidationDataGenerator,
      });
    },
  });
}

module.exports = { createProductionController: createProductionController };
