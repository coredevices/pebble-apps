const test = require('node:test');
const assert = require('node:assert/strict');
const { StandardWebSocket } = require('../src/runtime/standard-websocket-provider');

class FakeWebSocket {
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.protocol = ''; this.sent = []; FakeWebSocket.last = this; }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed = [code, reason]; }
}

test('maps standard WebSocket events onto the effects contract', () => {
  const events = [];
  const socket = new StandardWebSocket(FakeWebSocket).open('wss://a.test/x', [], e => events.push(e));
  const ws = FakeWebSocket.last;
  assert.equal(ws.url, 'wss://a.test/x');
  assert.equal(ws.protocols, undefined);
  assert.equal(ws.binaryType, 'arraybuffer');
  ws.onopen();
  ws.onmessage({ data: 'hi' });
  ws.onmessage({ data: new Uint8Array([1, 2]).buffer });
  ws.onerror();
  ws.onclose({ code: 1006, wasClean: false });
  assert.deepEqual(events[0], { type: 'open', protocol: '' });
  assert.deepEqual(events[1], { type: 'message', data: 'hi', binary: false });
  assert.deepEqual([...events[2].data], [1, 2]);
  assert.equal(events[2].binary, true);
  assert.deepEqual(events[3], { type: 'error' });
  assert.deepEqual(events[4], { type: 'close', code: 1006, clean: false });
  socket.sendText('t');
  assert.throws(() => socket.sendText(1), TypeError);
  socket.close();
  assert.deepEqual(ws.sent, ['t']);
  assert.deepEqual(ws.closed, [1000, '']);
});
