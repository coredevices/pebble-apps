'use strict';

var bytes = require('./bytes');
var callbacks = Object.create(null);

function HostTlsSocket(nativeInterface, globalObject) {
  if (!nativeInterface || typeof nativeInterface.open !== 'function') {
    throw new TypeError('Native TLS socket transport is unavailable.');
  }
  this.native = nativeInterface;
  globalObject = globalObject || globalThis;
  if (typeof globalObject.__hostTlsSocketDispatch !== 'function') {
    globalObject.__hostTlsSocketDispatch = function (id, event) {
      var callback = callbacks[String(id)];
      if (callback) callback(event);
    };
  }
}

HostTlsSocket.prototype.open = function (options, onEvent) {
  if (!options || typeof options !== 'object' || typeof onEvent !== 'function') {
    throw new TypeError('TLS socket options and event handler are required.');
  }
  var nativeInterface = this.native;
  var request = {
    host: options.host,
    port: options.port,
    serverName: options.serverName,
    alpn: (options.alpn || []).slice(),
    trustAnchors: (options.trustAnchors || []).map(bytes.bytesToBase64),
    connectTimeoutMillis: options.connectTimeoutMillis || 20000,
  };
  var id = nativeInterface.open(JSON.stringify(request));
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('Native TLS socket returned an invalid handle.');
  callbacks[String(id)] = function (event) {
    if (!event || typeof event !== 'object') return;
    var copied = event.type === 'data'
      ? { type: 'data', data: bytes.base64ToBytes(event.data) }
      : event;
    onEvent(copied);
    if (event.type === 'close') delete callbacks[String(id)];
  };
  return Object.freeze({
    id: id,
    write: function (data) { nativeInterface.write(id, bytes.bytesToBase64(data)); },
    close: function () { nativeInterface.close(id); },
  });
};

module.exports = { HostTlsSocket: HostTlsSocket };
