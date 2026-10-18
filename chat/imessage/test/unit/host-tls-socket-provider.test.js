'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var HostTlsSocket = require('../../src/runtime/host-tls-socket-provider').HostTlsSocket;
var trust = require('../../src/aps/courier-trust');

test('host TLS adapter maps generic stream requests and callbacks without protocol policy', function () {
  var calls = [];
  var globalObject = {};
  var transport = new HostTlsSocket({
    open: function (request) { calls.push(['open', JSON.parse(request)]); return 9; },
    write: function (id, data) { calls.push(['write', id, data]); },
    close: function (id) { calls.push(['close', id]); },
  }, globalObject);
  var events = [];
  var socket = transport.open({
    host: '1-courier.example', port: 5223, serverName: 'courier.example',
    alpn: ['packed-v1', 'raw-v1'], trustAnchors: trust.courierTrustAnchors(),
  }, function (event) { events.push(event); });
  socket.write(Uint8Array.from([1, 2, 3]));
  globalObject.__hostTlsSocketDispatch(9, { type: 'open', protocol: 'raw-v1' });
  globalObject.__hostTlsSocketDispatch(9, { type: 'data', data: 'BAU=' });
  socket.close();
  assert.equal(calls[0][1].host, '1-courier.example');
  assert.deepEqual(calls[0][1].alpn, ['packed-v1', 'raw-v1']);
  assert.equal(calls[0][1].trustAnchors.length, 2);
  assert.deepEqual(calls.slice(1), [['write', 9, 'AQID'], ['close', 9]]);
  assert.equal(events[0].protocol, 'raw-v1');
  assert.deepEqual(events[1].data, Uint8Array.from([4, 5]));
});
