// PKJS half of the complication face (see plugins.md, "User preferences").
//
// The face has two slots, each drawing one fixed shape: a number (with a gauge when the reading
// has a range) and a bitmap. Neither is configured here: each takes the first of the user's
// preferred readings (`preferences/complications`) that comes in its shape and isn't already in
// the other slot.

var NUMBER = 'numericValue';
var BITMAPS = ['image', 'icon'];

// Until the watch says how big its bitmap slot is.
var imageSize = 40;
var preferred = [];
var subscriptions = [];
var sentPixels = '';

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
function declaredShapes(slot) {
  var shapes = [];
  Pebble.enumeratePlugins().forEach(function (plugin) {
    plugin.sources.forEach(function (source) {
      if (source.category !== slot.category || source.items.indexOf(slot.item) === -1) return;
      shapes = shapes.concat((source.properties || {})[slot.property] || []);
    });
  });
  return shapes;
}

/** The first preferred reading offering one of [shapes] that [taken] doesn't already have. */
function pick(shapes, taken) {
  return preferred.filter(function (slot) {
    if (taken && slot.key === taken.key) return false;
    var offered = declaredShapes(slot);
    return shapes.some(function (shape) { return offered.indexOf(shape) !== -1; });
  })[0];
}

/** A reading's instance name (London, Phone), else the reading itself. */
function labelOf(instance, slot) {
  return textOf(instance.properties.name) || slot.property.replace(/_/g, ' ');
}

function send(message) {
  Pebble.sendAppMessage(message, function () {}, function (e) {
    log('sendAppMessage failed: ' + JSON.stringify(e));
  });
}

function onNumber(slot, envelope) {
  var instance = envelope.instances[slot.index];
  var payloads = instance && instance.properties[slot.property];
  var number = payloads && payloads[NUMBER];
  if (!number) {
    send({ numText: '--', numLabel: '', numFill: -1 });
    return;
  }
  var text = textOf(payloads) || (Math.round(number.value) + (number.unit || ''));
  var hasRange = number.min !== undefined && number.max !== undefined && number.max > number.min;
  var fill = hasRange ? Math.round((number.value - number.min) / (number.max - number.min) * 100) : -1;
  send({ numText: text, numLabel: labelOf(instance, slot), numFill: Math.max(-1, Math.min(100, fill)) });
}

function onImage(slot, envelope) {
  var instance = envelope.instances[slot.index];
  var payloads = (instance && instance.properties[slot.property]) || {};
  var bitmap = payloads.image || payloads.icon;
  if (!bitmap || bitmap.pixels === sentPixels) return;
  sentPixels = bitmap.pixels;
  Pebble.sendAppMessage({
    imgLabel: labelOf(instance, slot),
    iconWidth: bitmap.width,
    iconHeight: bitmap.height,
    iconPalette: bytesOf(bitmap.palette),
    iconPixels: bytesOf(bitmap.pixels),
  }, function () {}, function (e) {
    sentPixels = '';
    log('sending the bitmap failed: ' + JSON.stringify(e));
  });
}

function subscribeSlots() {
  subscriptions.forEach(function (subscription) { subscription.unsubscribe(); });
  subscriptions = [];
  sentPixels = '';
  var number = pick([NUMBER]);
  var image = pick(BITMAPS, number);
  log('number: ' + (number ? number.key : 'none') + '; image: ' + (image ? image.key : 'none'));
  if (number) {
    subscriptions.push(Pebble.subscribeToSource({
      category: number.category,
      item: number.item,
      properties: ['name', number.property],
      onData: function (envelope) { onNumber(number, envelope); },
      onError: function (err) {
        log(number.key + ': ' + err.code);
        send({ numText: '--', numLabel: err.code === 'PERMISSION_DENIED' ? 'Needs permission' : '', numFill: -1 });
      },
    }));
  }
  if (image) {
    subscriptions.push(Pebble.subscribeToSource({
      category: image.category,
      item: image.item,
      properties: ['name', image.property],
      iconPixelSize: { w: imageSize, h: imageSize },
      onData: function (envelope) { onImage(image, envelope); },
      onError: function (err) { log(image.key + ': ' + err.code); },
    }));
  }
}

function onPreferred(envelope) {
  preferred = envelope.instances.map(function (instance) {
    var p = instance.properties;
    var slot = {
      category: textOf(p.category),
      item: textOf(p.item),
      index: p.index && p.index.numericValue ? p.index.numericValue.value : 0,
      property: textOf(p.property),
    };
    slot.key = [slot.category, slot.item, slot.index, slot.property].join('/');
    return slot;
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

// Nothing on the watch can scale a bitmap, so it says how big the image slot is.
Pebble.addEventListener('appmessage', function (e) {
  var size = (e.payload || {}).imageSize;
  if (size === undefined || size === imageSize) return;
  imageSize = size;
  log('watch wants ' + imageSize + 'px images');
  subscribeSlots();
});
