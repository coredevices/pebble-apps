const test = require('node:test');
const assert = require('node:assert/strict');
const { FetchHttpProvider } = require('../src/runtime/fetch-http-provider');

function fakeTimer() {
  const timers = new Map();
  let next = 1;
  return {
    timers,
    after(delay, callback) { timers.set(next, callback); return next++; },
    cancel(handle) { timers.delete(handle); },
    fire() { [...timers.values()].forEach(callback => callback()); },
  };
}

function response(status, headers, body) {
  return {
    status,
    headers: { forEach: callback => Object.entries(headers).forEach(([name, value]) => callback(value, name)) },
    arrayBuffer: async () => new Uint8Array(body).buffer,
  };
}

const request = extra => ({ method: 'POST', url: 'https://example.test/x', headers: [['X-A', '1'], ['X-A', '2']], body: new Uint8Array([97, 61, 98]), ...extra });

test('maps the request onto fetch and normalizes the response', async () => {
  const timer = fakeTimer();
  let seen;
  const provider = new FetchHttpProvider((url, init) => { seen = { url, init }; return Promise.resolve(response(201, { 'Content-Type': 'a/b' }, [9, 8])); }, timer);
  const result = await provider.request(request());
  assert.equal(seen.url, 'https://example.test/x');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['X-A'], '1, 2');
  assert.equal(seen.init.body, 'a=b');
  assert.equal(seen.init.responseType, 'arraybuffer');
  assert.equal(result.status, 201);
  assert.deepEqual(result.headers, [['content-type', 'a/b']]);
  assert.deepEqual([...result.body], [9, 8]);
  assert.equal(timer.timers.size, 0);
});

test('empty bodies are omitted', async () => {
  let init;
  await new FetchHttpProvider((_, value) => { init = value; return response(200, {}, []); }, fakeTimer())
    .request(request({ method: 'GET', body: new Uint8Array(0) }));
  assert.equal(init.body, undefined);
});

test('failures map to transport errors', async () => {
  const rejected = new FetchHttpProvider(() => Promise.reject(new Error('offline')), fakeTimer());
  await assert.rejects(rejected.request(request()), { code: 'HTTP_NETWORK_ERROR', retryable: true });
  const large = new FetchHttpProvider(() => response(200, {}, [1, 2, 3]), fakeTimer());
  await assert.rejects(large.request(request({ maxResponseBytes: 2 })), { code: 'HTTP_RESPONSE_TOO_LARGE' });
  const timer = fakeTimer();
  const hanging = new FetchHttpProvider(() => new Promise(() => {}), timer).request(request({ timeoutMillis: 5 }));
  timer.fire();
  await assert.rejects(hanging, { code: 'HTTP_TIMEOUT' });
  await assert.rejects(large.request(request({ headers: [['bad header', 'x']] })), TypeError);
});
