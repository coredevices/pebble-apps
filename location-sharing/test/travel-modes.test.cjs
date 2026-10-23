const test = require('node:test');
const assert = require('node:assert/strict');
const { LocationSharingController, pickRoutes } = require('../src/location-sharing/controller');

const route = (minutes) => ({ seconds: minutes * 60, duration: minutes + ' min', distance: '1 mi' });

test('auto shows walk and bike when either is under 20 minutes', () => {
  const picked = pickRoutes({ walk: route(12), bike: route(5), drive: route(3) }, { auto: true });
  assert.deepEqual(Object.keys(picked).sort(), ['bike', 'walk']);
});

test('auto shows only the quick one of walk and bike', () => {
  const picked = pickRoutes({ walk: route(45), bike: route(15), drive: route(6) }, { auto: true });
  assert.deepEqual(Object.keys(picked), ['bike']);
});

test('auto shows driving when walking and biking both take 20 minutes or more', () => {
  const picked = pickRoutes({ walk: route(90), bike: route(20), drive: route(10) }, { auto: true });
  assert.deepEqual(Object.keys(picked), ['drive']);
});

test('checked modes are always shown alongside auto', () => {
  const picked = pickRoutes({ walk: route(90), bike: route(30), drive: route(10) }, { auto: true, walk: true });
  assert.deepEqual(Object.keys(picked).sort(), ['drive', 'walk']);
});

test('without auto only checked modes are shown', () => {
  const picked = pickRoutes({ walk: route(5), bike: route(3), drive: route(2) }, { drive: true });
  assert.deepEqual(Object.keys(picked), ['drive']);
});

test('auto is on for new users and off for settings saved before it existed', () => {
  const settingsFrom = (saved) => LocationSharingController.prototype.settings.call({ storage: { get: () => saved } }).show;
  assert.deepEqual(settingsFrom(null), { auto: true, drive: false, bike: false, walk: false });
  assert.deepEqual(settingsFrom(JSON.stringify({ show: { drive: true } })), { auto: false, drive: true, bike: false, walk: false });
});

test('answer puts the travel time in the sentence, not an aside', () => {
  const { answerText } = require('../src/location-sharing/controller');
  const person = { id: 'w', name: 'Wife', latitude: 37.3352, longitude: -121.8811, address: '1 Washington Sq, San Jose, CA', timestampMs: 0 };
  const settings = { nicknames: {}, places: [] };
  assert.equal(answerText(person, settings, { drive: route(30) }, 3 * 60000),
    'Wife is at 1 Washington Sq, San Jose, 30 min drive away (1 mi). Updated 3 minutes ago.');
  assert.equal(answerText(person, settings, {}, 3 * 60000), 'Wife is at 1 Washington Sq, San Jose. Updated 3 minutes ago.');
});
