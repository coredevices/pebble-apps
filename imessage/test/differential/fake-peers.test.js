'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DeterministicResolver } = require('../../harness/deterministic-resolver');
const { httpExchange, tlsScript, websocketScript } = require('../../harness/fake-peers');
const { byteString, createEffect } = require('../../harness/schema');

test('scripted peers cover HTTP, WebSocket, and fragmented TLS without ambient traffic', async function () {
  const script = [
    httpExchange(
      { method: 'POST', url: 'https://fixture.invalid/path', headers: [['X-Test', 'one'], ['X-Test', 'two']] },
      { status: 200, headers: [['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2']], body: [9] }
    ),
    ...websocketScript([
      { type: 'open', url: 'wss://fixture.invalid/socket', protocols: ['fixture-v1'], protocol: 'fixture-v1' },
      { type: 'expectText', text: 'hello' },
      { type: 'sendBinary', data: [1, 2] },
    ]),
    ...tlsScript([
      { type: 'open', host: 'fixture.invalid', port: 443, alpn: ['fixture-v1'], negotiatedAlpn: 'fixture-v1' },
      { type: 'expectWrite', data: [4, 5, 6] },
      { type: 'sendFragment', data: [7] },
      { type: 'sendFragment', data: [8, 9] },
    ]),
  ];
  const resolver = new DeterministicResolver({ script });
  const effects = [
    createEffect('http.request', { requestId: 'h1', method: 'POST', url: 'https://fixture.invalid/path', headers: [['X-Test', 'one'], ['X-Test', 'two']] }),
    createEffect('websocket.open', { requestId: 'w1', socketId: 'socket', url: 'wss://fixture.invalid/socket', protocols: ['fixture-v1'] }),
    createEffect('websocket.send', { requestId: 'w2', socketId: 'socket', frameType: 'text', text: 'hello' }),
    createEffect('websocket.receive', { requestId: 'w3', socketId: 'socket' }),
    createEffect('tls.open', { requestId: 't1', streamId: 'stream', host: 'fixture.invalid', port: 443, alpn: ['fixture-v1'] }),
    createEffect('tls.write', { requestId: 't2', streamId: 'stream', data: byteString([4, 5, 6]) }),
    createEffect('tls.read', { requestId: 't3', streamId: 'stream' }),
    createEffect('tls.read', { requestId: 't4', streamId: 'stream' }),
  ];
  const events = [];
  for (const effect of effects) events.push(await resolver.resolveEffect(effect, {}));
  resolver.assertExhausted();

  assert.deepEqual(events[0].headers, [['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2']]);
  assert.deepEqual(events[3].data, byteString([1, 2]));
  assert.deepEqual(events[6].data, byteString([7]));
  assert.deepEqual(events[7].data, byteString([8, 9]));
});

test('fake peers fail at the first mismatched request field without echoing data', async function () {
  const resolver = new DeterministicResolver({
    script: [httpExchange(
      { method: 'GET', url: 'https://fixture.invalid/expected', headers: [] },
      { status: 204, headers: [] }
    )],
  });
  await assert.rejects(
    resolver.resolveEffect(createEffect('http.request', {
      requestId: 'h1',
      method: 'GET',
      url: 'https://fixture.invalid/other',
      headers: [],
    }), {}),
    function (error) {
      return error.name === 'FakePeerMismatchError' && error.path === '$.url';
    }
  );
});
