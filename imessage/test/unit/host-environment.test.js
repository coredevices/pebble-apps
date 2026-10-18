'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var environment = require('../../src/runtime/host-environment');

function FakeXhr() {
  FakeXhr.last = this;
  this.headers = [];
  this.status = 201;
  this.response = new Uint8Array([4, 5]).buffer;
  this._responseHeaderEntries = [['set-cookie', 'a=1'], ['set-cookie', 'b=2']];
}
FakeXhr.prototype.open = function (method, url, async) { this.opened = [method, url, async]; };
FakeXhr.prototype.setRequestHeader = function (name, value) { this.headers.push([name, value]); };
FakeXhr.prototype.send = function (body) { this.body = body; this.onload(); };

function fakeTimer() {
  return {
    after: function () { return 1; },
    cancel: function () {},
  };
}

test('XHR effect preserves duplicate request and response headers and binary bodies', async function () {
  var provider = new environment.XhrHttpProvider(FakeXhr, fakeTimer());
  var response = await provider.request({
    method: 'POST', url: 'https://example.invalid/',
    headers: [['x-test', 'one'], ['x-test', 'two']], body: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(FakeXhr.last.opened, ['POST', 'https://example.invalid/', true]);
  assert.deepEqual(FakeXhr.last.headers, [['x-test', 'one'], ['x-test', 'two']]);
  assert.deepEqual(Array.from(FakeXhr.last.body), [1, 2, 3]);
  assert.equal(response.status, 201);
  assert.deepEqual(response.headers, [['set-cookie', 'a=1'], ['set-cookie', 'b=2']]);
  assert.deepEqual(Array.from(response.body), [4, 5]);
});

test('XHR effect reports transport failures without leaking request data', async function () {
  function FailedXhr() { FakeXhr.call(this); }
  FailedXhr.prototype = Object.create(FakeXhr.prototype);
  FailedXhr.prototype.send = function () { this.onerror(); };
  await assert.rejects(function () {
    return new environment.XhrHttpProvider(FailedXhr, fakeTimer()).request({
      method: 'POST', url: 'https://example.invalid/', headers: [], body: new Uint8Array([9]),
    });
  }, function (error) { return error.code === 'HTTP_NETWORK_ERROR' && !error.message.includes('9'); });
});

test('XHR effect aborts a stalled request at the JS-owned deadline', async function () {
  var callback;
  var cancelled = [];
  var timer = {
    after: function (delayMillis, handler) {
      assert.equal(delayMillis, 1234);
      callback = handler;
      return 7;
    },
    cancel: function (handle) { cancelled.push(handle); },
  };
  function StalledXhr() { FakeXhr.call(this); this.aborted = false; }
  StalledXhr.prototype = Object.create(FakeXhr.prototype);
  StalledXhr.prototype.send = function () {};
  StalledXhr.prototype.abort = function () { this.aborted = true; this.onabort(); };

  var pending = new environment.XhrHttpProvider(StalledXhr, timer, 1234).request({
    method: 'GET', url: 'https://example.invalid/', headers: [], body: new Uint8Array(0),
  });
  callback();
  await assert.rejects(pending, function (error) { return error.code === 'HTTP_TIMEOUT'; });
  assert.equal(FakeXhr.last.aborted, true);
  assert.deepEqual(cancelled, [7]);
});

test('XHR effect cancels its deadline after a response and validates timeout configuration', async function () {
  var cancelled = [];
  var timer = {
    after: function () { return 9; },
    cancel: function (handle) { cancelled.push(handle); },
  };
  await new environment.XhrHttpProvider(FakeXhr, timer, 500).request({
    method: 'GET', url: 'https://example.invalid/', headers: [], body: new Uint8Array(0),
  });
  assert.deepEqual(cancelled, [9]);
  await assert.rejects(function () {
    return new environment.XhrHttpProvider(FakeXhr, timer).request({
      method: 'GET', url: 'https://example.invalid/', headers: [], body: new Uint8Array(0), timeoutMillis: 0,
    });
  }, /timeout is invalid/);
  await assert.rejects(function () {
    return new environment.XhrHttpProvider(FakeXhr, timer).request({
      method: 'GET', url: 'https://example.invalid/', headers: [], body: new Uint8Array(0), maxResponseBytes: 0,
    });
  }, /byte limit is invalid/);
  assert.throws(function () { return new environment.XhrHttpProvider(FakeXhr); }, /timer service/);
});

test('XHR effect aborts during transfer and rechecks the final binary response byte limit', async function () {
  function ProgressXhr() { FakeXhr.call(this); this.aborted = false; }
  ProgressXhr.prototype = Object.create(FakeXhr.prototype);
  ProgressXhr.prototype.send = function () { this.onprogress({ loaded: 9 }); };
  ProgressXhr.prototype.abort = function () { this.aborted = true; this.onabort(); };
  await assert.rejects(function () {
    return new environment.XhrHttpProvider(ProgressXhr, fakeTimer()).request({
      method: 'GET', url: 'https://example.invalid/', headers: [], body: new Uint8Array(0), maxResponseBytes: 8,
    });
  }, function (error) { return error.code === 'HTTP_RESPONSE_TOO_LARGE'; });
  assert.equal(FakeXhr.last.aborted, true);

  await assert.rejects(function () {
    return new environment.XhrHttpProvider(FakeXhr, fakeTimer()).request({
      method: 'GET', url: 'https://example.invalid/', headers: [], body: new Uint8Array(0), maxResponseBytes: 1,
    });
  }, function (error) { return error.code === 'HTTP_RESPONSE_TOO_LARGE'; });
});

test('storage and random providers stay protocol agnostic', function () {
  var values = new Map();
  var storage = new environment.LocalStorageProvider({
    getItem: function (key) { return values.has(key) ? values.get(key) : null; },
    setItem: function (key, value) { values.set(key, value); },
    removeItem: function (key) { values.delete(key); },
  });
  storage.set('key', 'value');
  assert.equal(storage.get('key'), 'value');
  storage.delete('key');
  assert.equal(storage.get('key'), null);
  assert.deepEqual(Array.from(environment.createRandomProvider({
    random: function (length) { return new Uint8Array(length).fill(7); },
  }).bytes(3)), [7, 7, 7]);
});

test('trace provider uses the supported console surface and emits only the event kind', function () {
  var calls = [];
  var trace = environment.createTraceProvider({
    info: function () { calls.push(Array.prototype.slice.call(arguments)); },
  });
  trace.emit({ kind: 'configuration.phase', secret: 'must-not-be-logged' });
  assert.deepEqual(calls, [['[iMessage state]', 'configuration.phase']]);
});
