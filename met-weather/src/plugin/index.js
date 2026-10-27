// Weather for the user's weather locations (or just where the phone is), from MET Norway's
// Locationforecast and Sunrise APIs (api.met.no): no key, but its terms want an identifying
// User-Agent, coordinates to at most 4 decimals, and Expires / If-Modified-Since respected.
// https://api.met.no/doc/TermsOfService
//
// Serves enough for the phone app to build the watch's weather app and timeline pins from it:
// see "Weather" in plugins.md.

var FORECAST_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
var SUN_URL = 'https://api.met.no/weatherapi/sunrise/3.0/sun';
var USER_AGENT = 'PebbleWeatherPluginDemo/1.0 github.com/coredevices/mobileapp';
var CACHE_KEY = 'forecast';
var SUN_KEY = 'sun';
var HISTORY_KEY = 'hours';
var HOURS = 48;
var DAYS = 7;
var HOUR_MS = 3600 * 1000;
var DAY_MS = 24 * HOUR_MS;
var DEFAULT_TTL_MS = 30 * 60 * 1000;

var LOCATIONS = { category: 'preferences', item: 'weather_location' };
var UNITS = { category: 'preferences', item: 'units' };

// ---------------------------------------------------------------- location

function currentPosition() {
  return new Promise(function (resolve, reject) {
    navigator.geolocation.getCurrentPosition(
      function (position) { resolve(position.coords); },
      function (error) { reject(error); },
      { maximumAge: 30 * 60 * 1000, timeout: 20 * 1000 }
    );
  });
}

/**
 * The user's weather locations, in their order, with the phone's position for the current-location
 * entry; just the phone's position if the app can't say.
 */
async function places() {
  var locations;
  try {
    locations = (await Pebble.readSource(LOCATIONS)).instances;
  } catch (e) {
    console.log('No weather locations (' + ((e && e.code) || e) + '); using the current position');
  }
  if (!locations || !locations.length) {
    return [{ id: 'current', name: 'Current location', current: true, coords: await currentPosition() }];
  }
  var found = await Promise.all(locations.map(async function (location) {
    var p = location.properties;
    var current = !!(p.current && p.current.boolean && p.current.boolean.value);
    var coords = { latitude: p.latitude && p.latitude.numericValue.value, longitude: p.longitude && p.longitude.numericValue.value };
    if (current || !p.latitude) {
      try {
        coords = await currentPosition();
      } catch (e) {
        return null;
      }
    }
    return { id: location.instanceId, name: p.name.shortText.text, current: current, coords: coords };
  }));
  return found.filter(function (place) { return place; });
}

// ---------------------------------------------------------------- units

/** `preferences/units`, or metric if the app can't say. */
async function units() {
  try {
    var p = (await Pebble.readSource(UNITS)).instances[0].properties;
    return { temperature: p.temperature.shortText.text, wind: p.wind_speed.shortText.text };
  } catch (e) {
    return { temperature: '°C', wind: 'km/h' };
  }
}

/** Text in the user's unit; `numericValue` stays in °C. */
function inUnit(celsius, unit) {
  return Math.round(unit === '°F' ? celsius * 9 / 5 + 32 : celsius) + unit;
}

function windText(metresPerSecond, unit) {
  var factor = { 'km/h': 3.6, mph: 2.23694, knots: 1.94384, 'm/s': 1 }[unit];
  if (!factor) return Math.round(metresPerSecond * 3.6) + ' km/h';
  return Math.round(metresPerSecond * factor) + ' ' + unit;
}

// ---------------------------------------------------------------- time

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

/** `+01:00` from minutes east of UTC. */
function offsetText(offsetMin) {
  var minutes = Math.abs(offsetMin);
  return (offsetMin < 0 ? '-' : '+') + pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
}

/** The start of the local day [ms] falls in. */
function localMidnight(ms, offsetMin) {
  var local = ms + offsetMin * 60000;
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - offsetMin * 60000;
}

/** `YYYY-MM-DD` of the local day starting at [midnight]. */
function localDate(midnight, offsetMin) {
  return new Date(midnight + offsetMin * 60000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- sun

function sunCache() {
  try { return JSON.parse(localStorage.getItem(SUN_KEY)) || {}; } catch (e) { return {}; }
}

/** Sunrise, sunset and solar noon (epoch ms, or null in polar day or night) for a local date. */
async function sunOn(coords, date, offsetMin) {
  var lat = coords.latitude.toFixed(2);
  var lon = coords.longitude.toFixed(2);
  var key = lat + ',' + lon + ',' + date + ',' + offsetMin;
  if (sunCache()[key]) return sunCache()[key];
  var response = await fetch(SUN_URL + '?lat=' + lat + '&lon=' + lon + '&date=' + date + '&offset=' +
    encodeURIComponent(offsetText(offsetMin)), { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error('MET sun returned ' + response.status);
  var p = (await response.json()).properties || {};
  function at(event) { return event && event.time ? Date.parse(event.time) : null; }
  var sun = { rise: at(p.sunrise), set: at(p.sunset), noon: at(p.solarnoon) };
  // Read again: other lookups ran while this one waited. Only what's still to come is worth keeping.
  var all = sunCache();
  var today = new Date().toISOString().slice(0, 10);
  Object.keys(all).forEach(function (k) { if (k.split(',')[2] < today) delete all[k]; });
  all[key] = sun;
  localStorage.setItem(SUN_KEY, JSON.stringify(all));
  return sun;
}

/**
 * Minutes east of UTC. The phone's own for where it is; elsewhere MET says nothing about time
 * zones, so it's estimated from solar noon, to the hour: right for most places, but an hour out
 * where the clocks are far from the sun (or in summer time).
 */
async function utcOffset(place) {
  if (place.current) return -new Date().getTimezoneOffset();
  var noon = (await sunOn(place.coords, new Date().toISOString().slice(0, 10), 0)).noon;
  if (noon === null) return Math.round(place.coords.longitude / 15) * 60;
  var noonUtcMin = new Date(noon).getUTCHours() * 60 + new Date(noon).getUTCMinutes();
  var offset = Math.round((12 * 60 - noonUtcMin) / 60) * 60;
  return offset > 14 * 60 ? offset - 24 * 60 : offset < -12 * 60 ? offset + 24 * 60 : offset;
}

// ---------------------------------------------------------------- hours seen

/**
 * MET's forecast starts at the current hour, so the hours already past today are kept from
 * earlier runs, for a series (and a high and low) that covers the whole day.
 */
function hoursSeen(place, midnight, date, series) {
  var all;
  try { all = JSON.parse(localStorage.getItem(HISTORY_KEY)) || {}; } catch (e) { all = {}; }
  var seen = all[place.id] && all[place.id].date === date ? all[place.id].hours : {};
  var now = Date.now();
  series.forEach(function (entry) {
    var at = Date.parse(entry.time);
    if (at >= midnight && at <= now) seen[at] = { temp: entry.data.instant.details.air_temperature, symbol: symbolOf(entry) };
  });
  all[place.id] = { date: date, hours: seen };
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  return seen;
}

// ---------------------------------------------------------------- forecast

function cacheKey(lat, lon) {
  return CACHE_KEY + ':' + lat + ',' + lon;
}

function cached(lat, lon) {
  try { return JSON.parse(localStorage.getItem(cacheKey(lat, lon))); } catch (e) { return null; }
}

/** The cached forecast if MET says it's still current; else a fresh one. */
async function forecastFor(coords) {
  // ~1km: close enough to share a forecast, and well inside MET's 4-decimal limit.
  var lat = coords.latitude.toFixed(2);
  var lon = coords.longitude.toFixed(2);
  var saved = cached(lat, lon);
  var samePlace = !!saved;
  if (samePlace && Date.now() < saved.expires) return saved;

  var headers = { 'User-Agent': USER_AGENT };
  if (samePlace && saved.lastModified) headers['If-Modified-Since'] = saved.lastModified;
  var response = await fetch(FORECAST_URL + '?lat=' + lat + '&lon=' + lon, { headers: headers });
  var expires = Date.parse(response.headers.get('expires')) || Date.now() + DEFAULT_TTL_MS;
  var fresh;
  if (response.status === 304 && samePlace) {
    fresh = saved;
  } else if (response.ok) {
    fresh = { lat: lat, lon: lon, body: await response.json(), lastModified: response.headers.get('last-modified') };
  } else {
    if (samePlace) return saved;
    throw new Error('MET returned ' + response.status);
  }
  fresh.expires = expires;
  localStorage.setItem(cacheKey(lat, lon), JSON.stringify(fresh));
  return fresh;
}

// ---------------------------------------------------------------- conditions

/** MET's symbol_code (e.g. `lightrainshowers_day`) onto the shared weather vocabulary. */
function conditionCode(symbol) {
  var name = (symbol || '').split('_')[0];
  var heavy = name.indexOf('light') !== 0;
  if (name.indexOf('sleet') >= 0) return 'rain_and_snow';
  if (name.indexOf('snow') >= 0) return heavy ? 'heavy_snow' : 'light_snow';
  if (name.indexOf('rain') >= 0) return heavy ? 'heavy_rain' : 'light_rain';
  if (name === 'clearsky' || name === 'fair') return 'sun';
  if (name === 'partlycloudy') return 'partly_cloudy';
  if (name === 'cloudy' || name === 'fog') return 'cloudy';
  return 'unknown';
}

function conditionText(symbol) {
  var name = (symbol || '').split('_')[0];
  var special = { clearsky: 'Clear', fair: 'Fair', fog: 'Fog' };
  if (special[name]) return special[name];
  var text = {
    partly_cloudy: 'Partly cloudy', cloudy: 'Cloudy', light_rain: 'Light rain', heavy_rain: 'Rain',
    light_snow: 'Light snow', heavy_snow: 'Snow', rain_and_snow: 'Sleet', sun: 'Clear',
  }[conditionCode(symbol)] || 'Unknown';
  return name.indexOf('thunder') >= 0 ? text + ', thunder' : text;
}

// ---------------------------------------------------------------- glyphs
// As the built-in weather plugin draws them, 4-bpp palettised with index 0 transparent: `image` is
// a disc in the condition's colour (1) with the shape in white (2); `icon` is the shape alone, in
// black (1), a little larger since there's no disc around it.

var DISC = { sun: 0xF8, partly_cloudy: 0xF8, light_snow: 0xCB, heavy_snow: 0xCB, light_rain: 0xC7, heavy_rain: 0xC7, rain_and_snow: 0xC7 };
var GREY = 0xEA;
var WHITE = 0xFF;
var BLACK = 0xC0;

function glyph(code, size, mono) {
  var canvas = new Uint8Array(size * size);
  var ink = mono ? 1 : 2;
  var scale = mono ? 1.25 : 1;
  function circle(cx, cy, r, colour) {
    for (var y = Math.max(0, Math.floor(cy - r)); y <= Math.min(size - 1, Math.ceil(cy + r)); y++) {
      for (var x = Math.max(0, Math.floor(cx - r)); x <= Math.min(size - 1, Math.ceil(cx + r)); x++) {
        var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) canvas[y * size + x] = colour;
      }
    }
  }
  function rect(left, top, width, height) {
    for (var y = Math.max(0, Math.floor(top)); y <= Math.min(size - 1, Math.floor(top + height)); y++) {
      for (var x = Math.max(0, Math.floor(left)); x <= Math.min(size - 1, Math.floor(left + width)); x++) {
        canvas[y * size + x] = ink;
      }
    }
  }
  function line(x0, y0, x1, y1, thickness) {
    var steps = Math.floor(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) * 2 + 1;
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thickness / 2, ink);
    }
  }
  function sun(cx, cy, r) {
    r *= scale;
    circle(cx, cy, r, ink);
    for (var i = 0; i < 8; i++) {
      var angle = i * Math.PI / 4;
      line(cx + Math.cos(angle) * r * 1.6, cy + Math.sin(angle) * r * 1.6,
        cx + Math.cos(angle) * r * 2.2, cy + Math.sin(angle) * r * 2.2, Math.max(1.5, size * 0.03));
    }
  }
  function cloud(lift) {
    var base = size * 0.62 - lift;
    var puff = size * 0.17 * scale;
    circle(size * 0.38, base - puff * 0.75, puff, ink);
    circle(size * 0.54, base - puff * 1.15, puff * 0.82, ink);
    circle(size * 0.66, base - puff * 0.55, puff * 0.66, ink);
    var half = puff * 0.42;
    var left = size * 0.30 - (scale - 1) * size * 0.06;
    var right = size * 0.70 + (scale - 1) * size * 0.06;
    circle(left, base - half, half, ink);
    circle(right, base - half, half, ink);
    rect(left, base - half * 2, right - left, half * 2);
  }
  function streaks(count, flakes) {
    cloud(size * -0.06);
    var top = size * 0.72;
    var first = 0.5 - (count - 1) * 0.06;
    for (var i = 0; i < count; i++) {
      var x = size * (first + i * 0.12);
      if (flakes) circle(x, top + size * 0.06, size * 0.04 * scale, ink);
      else line(x, top, x - size * 0.05, top + size * 0.12, Math.max(1.5, size * 0.035 * scale));
    }
  }

  if (!mono) circle(size / 2, size / 2, size / 2, 1);
  switch (code) {
    case 'sun': sun(size / 2, size / 2, size * 0.16); break;
    case 'partly_cloudy': sun(size * 0.62, size * 0.32, size * 0.12); cloud(size * 0.06); break;
    case 'cloudy': cloud(0); break;
    case 'light_rain': streaks(3, false); break;
    case 'heavy_rain': streaks(4, false); break;
    case 'light_snow': streaks(3, true); break;
    case 'heavy_snow': streaks(4, true); break;
    case 'rain_and_snow': streaks(2, false); streaks(1, true); break;
    default:
      // No shape: the disc says "some weather"; without one, an outline does.
      if (mono) {
        circle(size / 2, size / 2, size * 0.44, ink);
        circle(size / 2, size / 2, size * 0.36, 0);
      }
  }

  // Two pixels a byte, even x in the high nibble, rows padded to a whole byte.
  var stride = Math.ceil(size / 2);
  var packed = '';
  for (var y = 0; y < size; y++) {
    for (var b = 0; b < stride; b++) {
      var hi = canvas[y * size + b * 2];
      var lo = b * 2 + 1 < size ? canvas[y * size + b * 2 + 1] : 0;
      packed += String.fromCharCode((hi << 4) | lo);
    }
  }
  var palette = mono ? [0x00, BLACK] : [0x00, DISC[code] || GREY, WHITE];
  return {
    pixels: btoa(packed),
    palette: btoa(String.fromCharCode.apply(null, palette)),
    width: size,
    height: size,
  };
}

/** `lightrainshowersandthunder_day` -> "Light rain showers and thunder". */
function conditionPhrase(symbol) {
  var words = (symbol || '').split('_')[0]
    .replace(/^lights(?=s)/, 'light') // MET spells two of its codes `lightssleet...` / `lightssnow...`
    .replace(/clearsky/, 'clear sky')
    .replace(/partlycloudy/, 'partly cloudy')
    .replace(/(light|heavy|rain|sleet|snow|showers|and)(?=[a-z])/g, '$1 ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

function conditionShapes(symbol, iconPixelSize, withPhrase) {
  var code = conditionCode(symbol);
  var shapes = { shortText: { text: conditionText(symbol) } };
  if (withPhrase) shapes.longText = { text: conditionPhrase(symbol) };
  if (iconPixelSize) {
    var size = Math.min(iconPixelSize.w, iconPixelSize.h);
    shapes.icon = glyph(code, size, true);
    shapes.image = glyph(code, size, false);
  }
  return shapes;
}


// ---------------------------------------------------------------- envelopes

function temperature(celsius, unit) {
  var text = inUnit(celsius, unit);
  return { shortText: { text: text }, longText: { text: text }, numericValue: { value: celsius, unit: '°C' } };
}

function percent(value) {
  return { numericValue: { value: value, unit: '%', min: 0, max: 100 }, shortText: { text: Math.round(value) + '%' } };
}

function symbolOf(entry) {
  var next = entry.data.next_1_hours || entry.data.next_6_hours || entry.data.next_12_hours;
  return next && next.summary && next.summary.symbol_code;
}

function chanceOf(entry) {
  var next = entry.data.next_1_hours || entry.data.next_6_hours || entry.data.next_12_hours;
  var chance = next && next.details && next.details.probability_of_precipitation;
  return typeof chance === 'number' ? chance : null;
}

function over(start, stepMs, shapes) {
  shapes.start = start / 1000;
  shapes.stepSec = stepMs / 1000;
  return { series: shapes };
}

/** Each local day's high, low, midday condition and chance of rain, from the forecast and the hours seen today. */
function days(timeseries, seen, midnight) {
  var out = [];
  for (var d = 0; d < DAYS; d++) {
    var from = midnight + d * DAY_MS;
    var to = from + DAY_MS;
    var temps = [];
    var symbol = null;
    var closest = Infinity;
    var chance = null;
    if (d === 0) Object.keys(seen).forEach(function (at) { temps.push(seen[at].temp); });
    timeseries.forEach(function (entry) {
      var at = Date.parse(entry.time);
      if (at < from || at >= to) return;
      temps.push(entry.data.instant.details.air_temperature);
      var six = entry.data.next_6_hours && entry.data.next_6_hours.details;
      if (six && typeof six.air_temperature_max === 'number') temps.push(six.air_temperature_max, six.air_temperature_min);
      var distance = Math.abs(at - (from + 13 * HOUR_MS));
      if (symbolOf(entry) && distance < closest) {
        symbol = symbolOf(entry);
        closest = distance;
      }
      var c = chanceOf(entry);
      if (c !== null) chance = Math.max(chance === null ? 0 : chance, c);
    });
    if (!temps.length || !symbol) break;
    out.push({ high: Math.max.apply(null, temps), low: Math.min.apply(null, temps), symbol: symbol, chance: chance });
  }
  return out;
}

function dailySeries(daily, sun, midnight, iconPixelSize, unit, wanted) {
  var properties = {
    daily_high: over(midnight, DAY_MS, {
      numericValue: { values: daily.map(function (d) { return d.high; }), unit: '°C' },
      shortText: { values: daily.map(function (d) { return inUnit(d.high, unit); }) },
    }),
    daily_low: over(midnight, DAY_MS, {
      numericValue: { values: daily.map(function (d) { return d.low; }), unit: '°C' },
      shortText: { values: daily.map(function (d) { return inUnit(d.low, unit); }) },
    }),
    daily_condition_code: over(midnight, DAY_MS, { longText: { values: daily.map(function (d) { return conditionCode(d.symbol); }) } }),
    daily_precipitation: over(midnight, DAY_MS, {
      numericValue: { values: daily.map(function (d) { return d.chance; }), unit: '%', min: 0, max: 100 },
    }),
    daily_sunrise: over(midnight, DAY_MS, { timestamp: { values: sun.map(function (s) { return s && s.rise !== null ? Math.round(s.rise / 1000) : null; }) } }),
    daily_sunset: over(midnight, DAY_MS, { timestamp: { values: sun.map(function (s) { return s && s.set !== null ? Math.round(s.set / 1000) : null; }) } }),
  };
  var condition = {
    shortText: { values: daily.map(function (d) { return conditionText(d.symbol); }) },
    longText: { values: daily.map(function (d) { return conditionPhrase(d.symbol); }) },
  };
  if (iconPixelSize && wanted('daily_condition')) {
    var size = Math.min(iconPixelSize.w, iconPixelSize.h);
    condition.icon = { values: daily.map(function (d) { return glyph(conditionCode(d.symbol), size, true); }) };
    condition.image = { values: daily.map(function (d) { return glyph(conditionCode(d.symbol), size, false); }) };
  }
  properties.daily_condition = over(midnight, DAY_MS, condition);
  return properties;
}

/** Today's and tomorrow's hours from local midnight: past ones from earlier runs, the rest from the forecast. */
function hourlySeries(timeseries, seen, midnight, iconPixelSize, unit) {
  var byTime = {};
  timeseries.forEach(function (entry) {
    byTime[Date.parse(entry.time)] = { temp: entry.data.instant.details.air_temperature, symbol: symbolOf(entry) };
  });
  var hours = [];
  for (var h = 0; h < HOURS; h++) {
    var at = midnight + h * HOUR_MS;
    hours.push(byTime[at] || seen[at] || null);
  }
  var temps = hours.map(function (hour) { return hour ? hour.temp : null; });
  var symbols = hours.map(function (hour) { return hour ? hour.symbol : null; });
  var condition = { shortText: { values: symbols.map(function (s) { return s ? conditionText(s) : null; }) } };
  if (iconPixelSize) {
    var size = Math.min(iconPixelSize.w, iconPixelSize.h);
    var drawn = {};
    var glyphFor = function (symbol, mono) {
      if (!symbol) return null;
      var key = conditionCode(symbol) + (mono ? ':mono' : ':colour');
      return drawn[key] || (drawn[key] = glyph(conditionCode(symbol), size, mono));
    };
    condition.icon = { values: symbols.map(function (s) { return glyphFor(s, true); }) };
    condition.image = { values: symbols.map(function (s) { return glyphFor(s, false); }) };
  }
  return {
    hourly_temperature: over(midnight, HOUR_MS, {
      numericValue: { values: temps, unit: '°C' },
      shortText: { values: temps.map(function (t) { return t === null ? null : inUnit(t, unit); }) },
    }),
    hourly_condition: over(midnight, HOUR_MS, condition),
    hourly_condition_code: over(midnight, HOUR_MS, { longText: { values: symbols.map(function (s) { return s ? conditionCode(s) : null; }) } }),
  };
}

async function locationInstance(place, forecast, request, userUnits) {
  var offset = await utcOffset(place);
  var midnight = localMidnight(Date.now(), offset);
  var timeseries = forecast.body.properties.timeseries;
  var upcoming = timeseries.filter(function (entry) { return Date.parse(entry.time) > Date.now() - HOUR_MS; });
  if (!upcoming.length) return null;
  var seen = hoursSeen(place, midnight, localDate(midnight, offset), timeseries);
  var wanted = function (prefix) {
    return !request.properties || request.properties.some(function (name) { return name.indexOf(prefix) === 0; });
  };
  var now = upcoming[0];
  var details = now.data.instant.details;
  var daily = days(timeseries, seen, midnight);
  var sun = await Promise.all(daily.map(function (d, i) {
    return sunOn(place.coords, localDate(midnight + i * DAY_MS, offset), offset).catch(function () { return null; });
  }));
  var unit = userUnits.temperature;
  var properties = {
    name: { shortText: { text: place.name } },
    temperature: temperature(details.air_temperature, unit),
    feels_like: temperature(typeof details.apparent_air_temperature === 'number' ? details.apparent_air_temperature : details.air_temperature, unit),
    condition: conditionShapes(symbolOf(now), request.iconPixelSize, true),
    condition_code: { longText: { text: conditionCode(symbolOf(now)) } },
    utc_offset: { numericValue: { value: offset, unit: 'min' } },
  };
  if (daily.length) {
    properties.high = temperature(daily[0].high, unit);
    properties.low = temperature(daily[0].low, unit);
  }
  if (typeof details.ultraviolet_index_clear_sky === 'number') {
    var uv = details.ultraviolet_index_clear_sky;
    properties.uv_index = { numericValue: { value: uv, min: 0, max: 11 }, shortText: { text: String(Math.round(uv)) } };
  }
  if (chanceOf(now) !== null) properties.precipitation = percent(chanceOf(now));
  if (typeof details.relative_humidity === 'number') properties.humidity = percent(details.relative_humidity);
  if (typeof details.wind_speed === 'number') {
    properties.wind_speed = { numericValue: { value: details.wind_speed, unit: 'm/s' }, shortText: { text: windText(details.wind_speed, userUnits.wind) } };
  }
  if (typeof details.wind_from_direction === 'number') {
    properties.wind_direction = { numericValue: { value: details.wind_from_direction, unit: '°', min: 0, max: 360 } };
  }
  if (sun[0] && sun[0].rise !== null) properties.sunrise = { timestamp: { value: Math.round(sun[0].rise / 1000) } };
  if (sun[0] && sun[0].set !== null) properties.sunset = { timestamp: { value: Math.round(sun[0].set / 1000) } };
  if (wanted('daily_') && daily.length) {
    var dailies = dailySeries(daily, sun, midnight, request.iconPixelSize, unit, wanted);
    Object.keys(dailies).forEach(function (name) { if (wanted(name)) properties[name] = dailies[name]; });
  }
  // A series of glyphs is costly to draw, so only for a subscriber that asked for the hours.
  if (wanted('hourly_')) {
    var hourly = hourlySeries(timeseries, seen, midnight, request.iconPixelSize, unit);
    Object.keys(hourly).forEach(function (name) { if (wanted(name)) properties[name] = hourly[name]; });
  }
  return { instanceId: place.id, properties: properties };
}

Pebble.registerSourceHandler(async function (request, respond) {
  // So this runs again when the user changes their locations or units.
  Pebble.subscribeSource(LOCATIONS);
  Pebble.subscribeSource(UNITS);
  var where;
  try {
    where = await places();
  } catch (e) {
    console.error('No location: ' + ((e && e.message) || e));
    respond.error('PERMISSION_DENIED', (e && e.message) || 'no location');
    return;
  }
  var userUnits = await units();
  var validUntil = Infinity;
  // A place MET can't be reached for is left out, rather than failing the others.
  var instances = (await Promise.all(where.map(async function (place) {
    try {
      var forecast = await forecastFor(place.coords);
      validUntil = Math.min(validUntil, forecast.expires);
      return await locationInstance(place, forecast, request, userUnits);
    } catch (e) {
      console.error('Fetching the MET forecast for ' + place.name + ' failed: ' + e);
      return null;
    }
  }))).filter(function (instance) { return instance; });
  if (!instances.length) {
    respond.error('PLUGIN_UNAVAILABLE', 'Could not reach MET Norway.');
    return;
  }
  respond.data({ validUntilMs: validUntil, instances: instances });
});
