'use strict';
// Travel times and address lookups from Google Maps' own web endpoints, which answer without a
// signed-in session. Routes are asked for directly with the request Maps' directions page sends;
// if Google stops accepting that, the page is loaded and the request it embeds is followed instead.
var bytes = require('../../../chat/imessage/src/runtime/bytes');

var MAPS_ORIGIN = 'https://www.google.com';
var USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
var TRAVEL_MODES = Object.freeze({ drive: 0, bike: 1, walk: 2 });
// Captured from www.google.com/maps/dir; only the two points and the travel mode change.
var DIRECTIONS_PB = '!1m4!3m2!3d{fromLat}!4d{fromLng}!6e2!1m4!3m2!3d{toLat}!4d{toLng}!6e2!3m12!1m3!1d3199722.634370091!2d-122.6715335!3d38.4477229!2m3!1f0.0!2f0.0!3f0.0!3m2!1i1024!2i768!4f13.1!6m62!1m5!18b1!30b1!31m1!1b1!34e1!2m4!5m1!6e2!20e3!39b1!6m31!32i1!49b1!63m0!66b1!85b1!114b1!149b1!206b1!209b1!212b1!215b1!216b1!222b1!223b1!234b1!235b1!239b1!246b1!253b1!260b1!262b1!266b1!270b1!271b1!273b1!277b1!281b1!291m0!294b1!302i300!303i100!10b1!12b1!13b1!14b1!16b1!17m1!3e1!20m5!1e{mode}!2e3!5e2!6b1!14b1!46m1!1b0!96b1!97m1!2b1!99b1!15m3!1s8X3OaoURis6Q8g-xsKqhBA!7e81!15i10142!20m28!1m6!1m2!1i0!2i0!2m2!1i530!2i768!1m6!1m2!1i974!2i0!2m2!1i1024!2i768!1m6!1m2!1i0!2i0!2m2!1i1024!2i20!1m6!1m2!1i0!2i748!2m2!1i1024!2i768!27b1!40i799!47m2!8b1!10e2';

function get(http, url) {
  return http.request({
    method: 'GET',
    url: url,
    headers: [['User-Agent', USER_AGENT], ['Accept-Language', 'en-US']],
    body: new Uint8Array(0),
    maxResponseBytes: 4 * 1024 * 1024
  }).then(function (response) {
    if (response.status < 200 || response.status >= 300) throw new Error('Google Maps returned HTTP ' + response.status + '.');
    return bytes.bytesToUtf8(response.body);
  });
}

function embeddedRequest(page, pattern) {
  var match = pattern.exec(page);
  return match ? match[0].replace(/&amp;/g, '&') : null;
}

function parseMapsJson(text) {
  return JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
}

function at(value, path) {
  return path.reduce(function (node, index) { return Array.isArray(node) ? node[index] : undefined; }, value);
}

function coordinate(point) {
  return point.latitude + ',' + point.longitude;
}

function directRequest(from, to, mode) {
  var values = { fromLat: from.latitude, fromLng: from.longitude, toLat: to.latitude, toLng: to.longitude, mode: TRAVEL_MODES[mode] };
  var pb = DIRECTIONS_PB.replace(/\{(\w+)\}/g, function (_, name) { return String(values[name]); });
  return 'preview/directions?authuser=0&hl=en&gl=us&pb=' + encodeURIComponent(pb);
}

async function pageRequest(http, from, to, mode) {
  var page = await get(http, MAPS_ORIGIN + '/maps/dir/' + coordinate(from) + '/' + coordinate(to) +
    '/data=!4m2!4m1!3e' + TRAVEL_MODES[mode] + '?hl=en');
  return embeddedRequest(page, /preview\/directions\?authuser=0&amp;[^"]*/);
}

function bestRoute(text) {
  var best = at(parseMapsJson(text), [0, 1, 0, 0]);
  var distance = at(best, [2]);
  var duration = at(best, [3]);
  if (!Number.isFinite(at(distance, [0])) || !Number.isFinite(at(duration, [0]))) return null;
  return {
    meters: distance[0],
    seconds: duration[0],
    distance: String(distance[1]).replace(/ miles?$/, ' mi'),
    duration: String(duration[1])
  };
}

/** The fastest route Google Maps suggests, as { meters, seconds, distance, duration }, or null. */
async function route(http, from, to, mode) {
  if (!(mode in TRAVEL_MODES)) throw new TypeError('Unknown travel mode ' + mode + '.');
  try {
    var direct = bestRoute(await get(http, MAPS_ORIGIN + '/maps/' + directRequest(from, to, mode)));
    if (direct) return direct;
  } catch (_) {
  }
  var request = await pageRequest(http, from, to, mode);
  return request ? bestRoute(await get(http, MAPS_ORIGIN + '/maps/' + request)) : null;
}

/** The coordinates of Google Maps' top result for an address, or null. */
async function geocode(http, address) {
  var page = await get(http, MAPS_ORIGIN + '/maps/search/' + encodeURIComponent(address) + '?hl=en');
  var request = embeddedRequest(page, /search\?tbm=map&amp;[^"]*/);
  if (!request) return null;
  var point = at(parseMapsJson(await get(http, MAPS_ORIGIN + '/' + request)), [0, 1, 0, 14, 9]);
  if (!Number.isFinite(at(point, [2])) || !Number.isFinite(at(point, [3]))) return null;
  return { latitude: point[2], longitude: point[3] };
}

function straightLineMeters(a, b) {
  var radians = Math.PI / 180;
  var dLat = (b.latitude - a.latitude) * radians;
  var dLon = (b.longitude - a.longitude) * radians;
  var h = Math.pow(Math.sin(dLat / 2), 2) +
    Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.pow(Math.sin(dLon / 2), 2);
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = { TRAVEL_MODES: TRAVEL_MODES, route: route, geocode: geocode, straightLineMeters: straightLineMeters };
