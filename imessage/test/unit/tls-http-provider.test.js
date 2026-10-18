'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var zlib = require('node:zlib');
var bytes = require('../../src/runtime/bytes');
var providerModule = require('../../src/runtime/tls-http-provider');

function FakeTimer() { this.next = 0; this.callbacks = new Map(); }
FakeTimer.prototype.after = function (_, callback) {
  this.next += 1;
  this.callbacks.set(this.next, callback);
  return this.next;
};
FakeTimer.prototype.cancel = function (id) { this.callbacks.delete(id); };

function fakeTls() {
  var result = { options: null, callback: null, writes: [], closed: false };
  result.open = function (options, callback) {
    result.options = options;
    result.callback = callback;
    return {
      write: function (value) { result.writes.push(new Uint8Array(value)); },
      close: function () { result.closed = true; },
    };
  };
  return result;
}

function request(tls, overrides) {
  return providerModule.requestOverTls(tls, new FakeTimer(), Object.assign({
    method: 'GET',
    url: 'https://init.example.test/bag?ix=3',
    headers: [],
    body: new Uint8Array(0),
    trustAnchors: [new Uint8Array([1, 2, 3])],
    maxResponseBytes: 1024,
  }, overrides || {}));
}

test('TLS HTTP provider sends HTTP/1.1 and reassembles a fragmented fixed-length response', async function () {
  var tls = fakeTls();
  var pending = request(tls);
  tls.callback({ type: 'open', protocol: 'http/1.1' });
  var outbound = bytes.bytesToUtf8(tls.writes[0]);
  assert.match(outbound, /^GET \/bag\?ix=3 HTTP\/1\.1\r\n/);
  assert.match(outbound, /\r\nHost: init\.example\.test\r\n/);
  assert.equal((outbound.match(/\r\nAccept-Encoding:/gi) || []).length, 1);
  var response = bytes.utf8ToBytes('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-Test: yes\r\n\r\nhello');
  tls.callback({ type: 'data', data: response.slice(0, 17) });
  tls.callback({ type: 'data', data: response.slice(17) });
  tls.callback({ type: 'close' });
  var value = await pending;
  assert.equal(value.status, 200);
  assert.equal(bytes.bytesToUtf8(value.body), 'hello');
  assert.deepEqual(value.headers, [['content-length', '5'], ['x-test', 'yes']]);
  assert.equal(tls.options.serverName, 'init.example.test');
  assert.deepEqual(tls.options.alpn, ['http/1.1']);
});

test('TLS HTTP provider preserves one caller-selected content encoding', async function () {
  var tls = fakeTls();
  var pending = request(tls, { headers: [['Accept-Encoding', 'gzip']] });
  tls.callback({ type: 'open', protocol: 'http/1.1' });
  var outbound = bytes.bytesToUtf8(tls.writes[0]);
  assert.equal((outbound.match(/\r\nAccept-Encoding:/gi) || []).length, 1);
  assert.match(outbound, /\r\nAccept-Encoding: gzip\r\n/);
  tls.callback({
    type: 'data',
    data: bytes.utf8ToBytes('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'),
  });
  tls.callback({ type: 'close' });
  await pending;
});

test('TLS HTTP provider decodes chunked responses and enforces the decoded byte limit', function () {
  var encoded = bytes.utf8ToBytes(
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntest\r\n3\r\n123\r\n0\r\n\r\n'
  );
  var value = providerModule.parseResponse(encoded, 7);
  assert.equal(bytes.bytesToUtf8(value.body), 'test123');
  assert.throws(function () { providerModule.parseResponse(encoded, 6); }, /byte limit/);
});

test('TLS HTTP provider decodes gzip content within the response byte limit', function () {
  var plaintext = bytes.utf8ToBytes('Apple IDS bag response '.repeat(64));
  var compressed = new Uint8Array(zlib.gzipSync(plaintext));
  var response = bytes.concatBytes(
    bytes.utf8ToBytes(
      'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: '
        + compressed.length + '\r\n\r\n'
    ),
    compressed
  );
  var value = providerModule.parseResponse(response, plaintext.length);
  assert.deepEqual(value.body, plaintext);
});

test('TLS HTTP provider rejects unsupported encodings and oversized gzip output', function () {
  assert.throws(function () {
    providerModule.parseResponse(bytes.utf8ToBytes(
      'HTTP/1.1 200 OK\r\nContent-Encoding: br\r\nContent-Length: 3\r\n\r\nabc'
    ), 32);
  }, /encoding is unsupported/);

  var plaintext = new Uint8Array(2048);
  var compressed = new Uint8Array(zlib.gzipSync(plaintext));
  var response = bytes.concatBytes(
    bytes.utf8ToBytes(
      'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: '
        + compressed.length + '\r\n\r\n'
    ),
    compressed
  );
  assert.throws(function () { providerModule.parseResponse(response, 1024); }, /invalid or too large/);
});

test('TLS HTTP provider rejects malformed lengths and transport failures', async function () {
  assert.throws(function () {
    providerModule.parseResponse(bytes.utf8ToBytes(
      'HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabc'
    ), 32);
  }, /truncated/);
  var tls = fakeTls();
  var pending = request(tls);
  tls.callback({ type: 'error', code: 'TLS_TRANSPORT_ERROR' });
  await assert.rejects(pending, /transport failed/);
  assert.equal(tls.closed, true);
});
