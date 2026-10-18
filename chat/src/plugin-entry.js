'use strict';

const ChatController = require('./controller').ChatController;
const IMessageAdapter = require('./imessage-adapter').IMessageAdapter;
const createProductionController = require('../../imessage/src/production-controller').createProductionController;
const CryptoCompositions = require('../../imessage/src/crypto/compositions').CryptoCompositions;
const NativeHostCryptoProvider = require('../../imessage/src/runtime/host-crypto-provider').NativeHostCryptoProvider;
const bytes = require('../../imessage/src/runtime/bytes');

const crypto = new CryptoCompositions(new NativeHostCryptoProvider(globalThis._HostCrypto));
const fingerprint = value => bytes.bytesToHex(crypto.digest('sha256', bytes.utf8ToBytes(value)));
const operationId = () => bytes.bytesToHex(crypto.random(16));

const controller = new ChatController({
  fingerprint, operationId,
  native: Pebble.chat,
  storage: globalThis.localStorage,
  createIMessage: function () {
    return new IMessageAdapter({
      controller: createProductionController(globalThis),
      storage: globalThis.localStorage,
      fingerprint, operationId,
      contacts: Pebble.chat,
      activationKeys: Pebble.chat,
    });
  },
});

Pebble.registerActionHandler((request, respond) => controller.handleAction(request, respond));
Pebble.registerConfigHandler((message, respond) => controller.handleConfig(message, respond));
