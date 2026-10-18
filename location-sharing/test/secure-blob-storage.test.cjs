const test = require('node:test');
const assert = require('node:assert/strict');
const { SecureBlobStorage } = require('../src/runtime/secure-blob-storage');

function secure(initial, { failWrites = 0 } = {}) {
  let raw = initial;
  let failures = failWrites;
  return {
    get raw() { return raw; },
    getItem: async () => raw,
    setItem: async (key, value) => {
      if (failures-- > 0) throw new Error('keystore');
      raw = value;
    },
  };
}

test('loads once, reads synchronously and writes only when changed', async () => {
  const store = secure(JSON.stringify({ a: '1' }));
  const storage = new SecureBlobStorage(store, 'state');
  await storage.loaded;
  assert.equal(storage.getItem('a'), '1');
  assert.equal(storage.getItem('missing'), null);
  await storage.flush();
  assert.equal(store.raw, JSON.stringify({ a: '1' }));
  storage.setItem('b', 2);
  storage.removeItem('a');
  await storage.flush();
  assert.deepEqual(JSON.parse(store.raw), { b: '2' });
});

test('a session that flushes after a disconnect cannot write the old sign-in back', async () => {
  const store = secure(JSON.stringify({ token: 'old', cache: 'x' }));
  const lookup = new SecureBlobStorage(store, 'state');
  const settings = new SecureBlobStorage(store, 'state');
  await Promise.all([lookup.loaded, settings.loaded]);
  settings.removeItem('token');
  await settings.flush();
  lookup.setItem('cache', 'y');
  await lookup.flush();
  assert.deepEqual(JSON.parse(store.raw), { cache: 'y' });
});

test('a failed write keeps its changes and does not block the next flush', async () => {
  const store = secure(null, { failWrites: 1 });
  const storage = new SecureBlobStorage(store, 'state');
  await storage.loaded;
  storage.setItem('a', '1');
  await assert.rejects(storage.flush(), /keystore/);
  await storage.flush();
  assert.deepEqual(JSON.parse(store.raw), { a: '1' });
});

test('unreadable saved state starts empty', async () => {
  const storage = new SecureBlobStorage(secure('not json'), 'state');
  await storage.loaded;
  assert.equal(storage.getItem('a'), null);
});
