const test = require('node:test');
const assert = require('node:assert/strict');
const { answerText, personProperties, withSettings } = require('../src/location-sharing/controller');
const maps = require('../src/location-sharing/maps');

const sjsu = { label: 'SJSU', address: '1 Washington Sq, San Jose, CA 95192', latitude: 37.3352, longitude: -121.8811, radiusMeters: 800 };
const settings = { nicknames: { w: 'my wife' }, places: [sjsu] };
const wife = { id: 'w', name: 'Wife', latitude: 37.3360, longitude: -121.8800, address: 'Duncan Hall, San Jose, CA', timestampMs: 0 };

test('the nickname and place are on the person, so sources, action data and answers all carry them', () => {
  const person = withSettings(wife, settings);
  assert.equal(person.nickname, 'my wife');
  assert.equal(person.place, 'SJSU');
  const properties = personProperties(person);
  assert.equal(properties.nickname.shortText.text, 'my wife');
  assert.equal(properties.place.shortText.text, 'SJSU');
  assert.equal(answerText(person, {}, 60000), 'Your wife is at SJSU. Updated 1 minute ago.');
});

test('outside every place and without a nickname the properties are left out', () => {
  const person = withSettings({ ...wife, id: 'h', latitude: 37.4419, longitude: -122.1430 }, settings);
  assert.equal(person.nickname, '');
  assert.equal(person.place, null);
  const properties = personProperties(person);
  assert.ok(!('nickname' in properties));
  assert.ok(!('place' in properties));
});

test('a person without coordinates is never at a place', () => {
  const person = withSettings({ ...wife, latitude: null, longitude: null }, { nicknames: {}, places: [{ ...sjsu, latitude: 0, longitude: 0 }] });
  assert.equal(person.place, null);
});

function controller(http) {
  const { LocationSharingController } = require('../src/location-sharing/controller');
  const saved = {};
  const status = () => ({ phase: 'disabled', ready: false });
  return new LocationSharingController({
    appleConfiguration: { status }, appleClient: { cached: () => [] },
    googleClient: { status: () => ({ configured: false }), cached: () => [] },
    prepareAppleConfiguration: async () => {},
    storage: { get: key => saved[key], set: (key, value) => { saved[key] = value; } }, http,
  });
}

test('adding a previewed place saves it without a second lookup; bad coordinates look the address up', async () => {
  const c = controller({ request: async () => { throw new Error('offline'); } });
  await c.handleConfig({ type: 'addPlace', label: 'SJSU', address: sjsu.address, radiusMeters: 800, latitude: sjsu.latitude, longitude: sjsu.longitude });
  assert.deepEqual(c.settings().places, [{ label: 'SJSU', address: sjsu.address, latitude: sjsu.latitude, longitude: sjsu.longitude, radiusMeters: 800 }]);
  const rejected = await c.handleConfig({ type: 'addPlace', label: 'Nowhere', address: 'x', radiusMeters: 100, latitude: 100, longitude: 200 });
  assert.equal(rejected.ok, false);
  assert.equal(c.settings().places.length, 1);
});

test('a Maps search result gives the point, name and address', () => {
  const entity = [];
  entity[9] = [null, null, 37.3352, -121.8811];
  entity[11] = 'Duncan Hall';
  entity[18] = 'Duncan Hall, 1 Washington Sq, San Jose, CA 95112';
  const text = ")]}'\n" + JSON.stringify([[null, [[null, null, null, null, null, null, null, null, null, null, null, null, null, null, entity]]]]);
  assert.deepEqual(maps.topResult(text), {
    latitude: 37.3352, longitude: -121.8811, name: 'Duncan Hall', address: 'Duncan Hall, 1 Washington Sq, San Jose, CA 95112',
  });
  assert.equal(maps.topResult(")]}'\n[[null,[[]]]]"), null);
});
