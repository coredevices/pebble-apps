'use strict';

var bytes = require('./bytes');

var nextCallbackId = 0;
var callbacks = Object.create(null);

function installDispatcher(globalObject) {
  if (typeof globalObject.__hostWebSocketDispatch === 'function') return;
  globalObject.__hostWebSocketDispatch = function (id, event) {
    var callback = callbacks[String(id)];
    if (callback) callback(event);
  };
}

function HostWebSocket(nativeInterface, globalObject) {
  if (!nativeInterface || typeof nativeInterface.open !== 'function') {
    throw new TypeError('Native WebSocket transport is unavailable.');
  }
  this.native = nativeInterface;
  this.globalObject = globalObject || globalThis;
  installDispatcher(this.globalObject);
}

HostWebSocket.prototype.open = function (url, protocols, onEvent) {
  if (typeof onEvent !== 'function') throw new TypeError('WebSocket event handler is required.');
  var nativeInterface = this.native;
  var id = nativeInterface.open(url, JSON.stringify(protocols || []));
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('Native WebSocket returned an invalid handle.');
  callbacks[String(id)] = function (event) {
    if (!event || typeof event !== 'object') return;
    var copied = event;
    if (event.type === 'message') {
      copied = {
        type: 'message',
        data: event.binary ? bytes.base64ToBytes(event.data) : bytes.bytesToUtf8(bytes.base64ToBytes(event.data)),
        binary: event.binary === true,
      };
    }
    onEvent(copied);
    if (event.type === 'close') delete callbacks[String(id)];
  };
  return Object.freeze({
    id: id,
    sendText: function (text) {
      if (typeof text !== 'string') throw new TypeError('WebSocket text must be a string.');
      nativeInterface.send(id, bytes.bytesToBase64(bytes.utf8ToBytes(text)), false);
    },
    sendBinary: function (data) {
      nativeInterface.send(id, bytes.bytesToBase64(data), true);
    },
    close: function (code, reason) {
      nativeInterface.close(id, code || 1000, reason || '');
    },
  });
};

module.exports = { HostWebSocket: HostWebSocket };
