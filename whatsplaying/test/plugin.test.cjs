const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(history) {
  let handler;
  const context = {
    localStorage: { getItem: (k) => (k === 'history' ? history : null) },
    Pebble: { registerSourceHandler: (h) => (handler = h) },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8'), context);
  return (request) => new Promise((resolve) => handler(request, { data: (d) => resolve(JSON.parse(JSON.stringify(d))), error: (code) => resolve({ code }) }));
}

test('the PKJS history is served newest first, with the match time and link', async () => {
  const read = load(JSON.stringify([
    { time: '2026-11-05T21:00:00.000Z', title: 'Monkeys Spinning Monkeys', artist: 'Kevin MacLeod', album: 'Single', song_link: 'https://lis.tn/x' },
    { time: '2026-11-05T20:00:00.000Z', title: 'Carefree', artist: 'Kevin MacLeod', album: '', song_link: '' },
  ]));
  const { instances } = await read({ category: 'music', item: 'identified' });
  assert.deepStrictEqual(instances.map((i) => i.properties.title.longText.text), ['Monkeys Spinning Monkeys', 'Carefree']);
  assert.strictEqual(instances[0].properties.identified.timestamp.value, 1793912400);
  assert.strictEqual(instances[0].properties.url.longText.text, 'https://lis.tn/x');
  assert.strictEqual(instances[1].properties.url, undefined);
});

test('a missing or corrupt history is empty, and other sources are refused', async () => {
  assert.deepStrictEqual((await load(null)({ category: 'music', item: 'identified' })).instances, []);
  assert.deepStrictEqual((await load('{oops')({ category: 'music', item: 'identified' })).instances, []);
  assert.strictEqual((await load('[]')({ category: 'music', item: 'track' })).code, 'INVALID_REQUEST');
});
