const assert = require('node:assert/strict');
const { test } = require('node:test');

const leadChange = require('../src/pkjs/lead-change');

function client(root, stored) {
  return leadChange(root, {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  });
}

test('changing servers silently seeds lead history and preserves favorites', () => {
  const stored = new Map([
    ['leadSeen', JSON.stringify({ 123: '2026-09-16T00:00:00.000Z' })],
    ['teams', JSON.stringify(['MLB:PHI'])],
  ]);
  const old = client('http://sports-api.rojas.tech', stored);
  const current = client('https://sports.cluster.repebble.com', stored);
  const opts = { id: 123, scoreHome: 0, scoreAway: 0 };
  assert.equal(old({ leadChangedAt: '2026-09-16T00:00:00.000Z' }, opts), 0);
  const seeded = { leadChangedAt: '2026-09-18T00:00:00.000Z' };
  assert.equal(current(seeded, opts), 0);
  assert.equal(current(seeded, opts), 0);
  const changed = { leadChangedAt: '2026-09-18T00:01:00.000Z' };
  assert.equal(current(changed, opts), 1);
  assert.equal(current(changed, opts), 0);
  assert.equal(client('https://sports.cluster.repebble.com', stored)(changed, opts), 0);
  assert.deepEqual(JSON.parse(stored.get('teams')), ['MLB:PHI']);
});
