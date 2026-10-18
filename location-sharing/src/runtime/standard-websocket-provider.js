'use strict';

// Adapts the engine's standard `WebSocket` to the effects websocket contract.
function StandardWebSocket(WebSocketImpl) {
  if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocket is unavailable.');
  this.WebSocket = WebSocketImpl;
}

StandardWebSocket.prototype.open = function (url, protocols, onEvent) {
  if (typeof onEvent !== 'function') throw new TypeError('WebSocket event handler is required.');
  var ws = protocols && protocols.length ? new this.WebSocket(url, protocols) : new this.WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = function () { onEvent({ type: 'open', protocol: ws.protocol }); };
  ws.onmessage = function (event) {
    var binary = typeof event.data !== 'string';
    onEvent({ type: 'message', data: binary ? new Uint8Array(event.data) : event.data, binary: binary });
  };
  ws.onerror = function () { onEvent({ type: 'error' }); };
  ws.onclose = function (event) { onEvent({ type: 'close', code: event.code, clean: event.wasClean }); };
  return Object.freeze({
    sendText: function (text) {
      if (typeof text !== 'string') throw new TypeError('WebSocket text must be a string.');
      ws.send(text);
    },
    sendBinary: function (data) { ws.send(data); },
    close: function (code, reason) { ws.close(code || 1000, reason || ''); },
  });
};

module.exports = { StandardWebSocket: StandardWebSocket };
