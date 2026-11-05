// PKJS half of the complication face (see plugins.md, "User preferences").
//
// The face has two slots, each showing either a bitmap or a value (a number, with a gauge when it
// has a range, or short text). Neither is configured here: the first slot takes the first of the
// user's preferred readings (`preferences/complications`) the face can draw. The second prefers
// the next reading offering the other kind, so the face shows one of each when it can, and
// otherwise takes the next reading it can draw.

var IMAGE = 'image';
var VALUE = 'value';
var KIND_SHAPES = {
  image: ['image', 'icon'],
  value: ['numericValue', 'shortText'],
};
var SLOT_COUNT = 2;

// Until the watch says how big its bitmap slots are.
var imageSize = 40;
var preferred = [];
var subscriptions = [];
var sentPixels = [];

function log(message) {
  console.log('[ComplicationFace] ' + message);
}

function textOf(payloads) {
  return payloads && payloads.shortText ? payloads.shortText.text : '';
}

/** Pebble's app message can carry bytes, so the bitmap travels as-is rather than as base64. */
function bytesOf(base64) {
  var binary = atob(base64);
  var bytes = [];
  for (var i = 0; i < binary.length; i++) bytes.push(binary.charCodeAt(i));
  return bytes;
}

/** The shapes some installed plugin declares for this reading. */
function declaredShapes(reading) {
  var shapes = [];
  Pebble.enumeratePlugins().forEach(function (plugin) {
    plugin.sources.forEach(function (source) {
      if (source.category !== reading.category || source.items.indexOf(reading.item) === -1) return;
      shapes = shapes.concat((source.properties || {})[reading.property] || []);
    });
  });
  return shapes;
}

function offers(reading, kind) {
  var shapes = declaredShapes(reading);
  return KIND_SHAPES[kind].some(function (shape) { return shapes.indexOf(shape) !== -1; });
}

/** How a reading is drawn when nothing asks for a particular kind: as a bitmap if it has one. */
function defaultKind(reading) {
  if (offers(reading, IMAGE)) return IMAGE;
  if (offers(reading, VALUE)) return VALUE;
  return null;
}

/** What goes in each slot: `{ reading, kind }`, or null when there's nothing left to show. */
function assign() {
  var drawable = preferred.filter(defaultKind);
  var first = drawable[0];
  if (!first) return [null, null];
  var firstKind = defaultKind(first);
  var rest = drawable.slice(1);
  var other = firstKind === IMAGE ? VALUE : IMAGE;
  var contrasting = rest.filter(function (reading) { return offers(reading, other); })[0];
  var second = contrasting
    ? { reading: contrasting, kind: other }
    : rest[0] ? { reading: rest[0], kind: defaultKind(rest[0]) } : null;
  return [{ reading: first, kind: firstKind }, second];
}

/** A reading's instance name (London, Phone), else the reading itself. */
function labelOf(instance, reading) {
  return (instance && textOf(instance.properties.name)) || reading.property.replace(/_/g, ' ');
}

function send(message) {
  Pebble.sendAppMessage(message, function () {}, function (e) {
    log('sendAppMessage failed: ' + JSON.stringify(e));
  });
}

function sendValue(slot, text, label, fill) {
  send({ slot: slot, numText: text, numLabel: label, numFill: fill });
}

function onValue(slot, reading, envelope) {
  var instance = envelope.instances[reading.index];
  var payloads = instance && instance.properties[reading.property];
  var number = payloads && payloads.numericValue;
  var text = textOf(payloads) || (number ? Math.round(number.value) + (number.unit || '') : '');
  if (!text) {
    sendValue(slot, '--', labelOf(instance, reading), -1);
    return;
  }
  var hasRange = number && number.min !== undefined && number.max !== undefined && number.max > number.min;
  var fill = hasRange ? Math.round((number.value - number.min) / (number.max - number.min) * 100) : -1;
  sendValue(slot, text, labelOf(instance, reading), Math.max(-1, Math.min(100, fill)));
}

function onImage(slot, reading, envelope) {
  var instance = envelope.instances[reading.index];
  var payloads = (instance && instance.properties[reading.property]) || {};
  var bitmap = payloads.image || payloads.icon;
  if (!bitmap || bitmap.pixels === sentPixels[slot]) return;
  sentPixels[slot] = bitmap.pixels;
  Pebble.sendAppMessage({
    slot: slot,
    imgLabel: labelOf(instance, reading),
    iconWidth: bitmap.width,
    iconHeight: bitmap.height,
    iconPalette: bytesOf(bitmap.palette),
    iconPixels: bytesOf(bitmap.pixels),
  }, function () {}, function (e) {
    sentPixels[slot] = '';
    log('sending the bitmap failed: ' + JSON.stringify(e));
  });
}

function subscribe(slot, assigned) {
  var reading = assigned.reading;
  var image = assigned.kind === IMAGE;
  var request = {
    category: reading.category,
    item: reading.item,
    properties: ['name', reading.property],
    onData: function (envelope) {
      if (image) onImage(slot, reading, envelope);
      else onValue(slot, reading, envelope);
    },
    onError: function (err) {
      log(reading.key + ': ' + err.code);
      sendValue(slot, '--', err.code === 'PERMISSION_DENIED' ? 'Needs permission' : '', -1);
    },
  };
  if (image) request.iconPixelSize = { w: imageSize, h: imageSize };
  subscriptions.push(Pebble.subscribeToSource(request));
}

function subscribeSlots() {
  subscriptions.forEach(function (subscription) { subscription.unsubscribe(); });
  subscriptions = [];
  sentPixels = [];
  var slots = assign();
  log(slots.map(function (s) { return s ? s.kind + ' ' + s.reading.key : 'none'; }).join('; '));
  for (var slot = 0; slot < SLOT_COUNT; slot++) {
    if (slots[slot]) subscribe(slot, slots[slot]);
    else sendValue(slot, '', '', -1);
  }
}

function onPreferred(envelope) {
  preferred = envelope.instances.map(function (instance) {
    var p = instance.properties;
    var reading = {
      category: textOf(p.category),
      item: textOf(p.item),
      index: p.index && p.index.numericValue ? p.index.numericValue.value : 0,
      property: textOf(p.property),
    };
    reading.key = [reading.category, reading.item, reading.index, reading.property].join('/');
    return reading;
  });
  subscribeSlots();
}

Pebble.addEventListener('ready', function () {
  log('ready');
  hello();
  Pebble.subscribeToSource({
    category: 'preferences',
    item: 'complications',
    onData: onPreferred,
    onError: function (err) { log('preferences/complications: ' + err.code); },
  });
});

/** Ask the watch for its bitmap slot size, which a restarted PKJS doesn't know. */
function hello(retries) {
  Pebble.sendAppMessage({ hello: 1 }, function () {}, function () {
    if (retries === 0) return;
    setTimeout(function () { hello(retries === undefined ? 2 : retries - 1); }, 1000);
  });
}

// Nothing on the watch can scale a bitmap, so it says how big the image slots are.
Pebble.addEventListener('appmessage', function (e) {
  var size = (e.payload || {}).imageSize;
  if (size === undefined || size === imageSize) return;
  imageSize = size;
  log('watch wants ' + imageSize + 'px images');
  subscribeSlots();
});
