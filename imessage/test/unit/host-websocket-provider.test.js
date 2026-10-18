'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var HostWebSocket = require('../../src/runtime/host-websocket-provider').HostWebSocket;

test('host WebSocket adapter keeps transport bytes generic and decodes callbacks', function () {
  var calls = [];
  var globalObject = {};
  var transport = new HostWebSocket({
    open: function (url, protocols) { calls.push(['open', url, protocols]); return 7; },
    send: function (id, data, binary) { calls.push(['send', id, data, binary]); },
    close: function (id, code, reason) { calls.push(['close', id, code, reason]); },
  }, globalObject);
  var events = [];
  var socket = transport.open('wss://example.test/socket', ['v1'], function (event) { events.push(event); });
  socket.sendText('hello');
  socket.sendBinary(Uint8Array.from([1, 2]));
  globalObject.__hostWebSocketDispatch(7, { type: 'message', data: 'aGk=', binary: false });
  globalObject.__hostWebSocketDispatch(7, { type: 'message', data: 'AwQ=', binary: true });
  socket.close(1000, 'done');
  assert.deepEqual(calls, [
    ['open', 'wss://example.test/socket', '["v1"]'],
    ['send', 7, 'aGVsbG8=', false],
    ['send', 7, 'AQI=', true],
    ['close', 7, 1000, 'done'],
  ]);
  assert.equal(events[0].data, 'hi');
  assert.deepEqual(events[1].data, Uint8Array.from([3, 4]));
});
