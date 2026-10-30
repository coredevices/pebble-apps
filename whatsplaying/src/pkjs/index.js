// SPDX-FileCopyrightText: 2026 Core Devices LLC
// SPDX-License-Identifier: Apache-2.0

// What's Playing — phone side.
//
// The watch streams its microphone; the firmware/phone app decode it and hand
// us 16 kHz mono PCM through `audiostream` events. We collect the PCM, POST it
// to sirensong (our AudD proxy, which holds the API token and wraps the PCM in
// a WAV) when the stream stops, and send the answer back to the watch. The
// last ten matches live in localStorage and are mirrored to the watch as a menu.

// Must match the Internet permission domain in package.json.
var SIRENSONG_URL = 'https://sirensong.cluster.repebble.com/v1/recognize';
var HISTORY_KEY = 'history';
var HISTORY_MAX = 10;

var DEFAULT_SAMPLE_RATE = 16000;
var BYTES_PER_SAMPLE = 2;
var MIN_SECONDS = 3;
var REQUEST_TIMEOUT_MS = 30000;

// Values of the CMD message key. Keep in sync with src/c/whatsplaying.h.
var CMD = {
  HELLO: 1,        // watch -> phone: please (re)send the history
  HISTORY: 2,      // phone -> watch: one history row (INDEX, TOTAL, TITLE, ARTIST, ALBUM)
  PROGRESS: 3,     // phone -> watch: SECONDS of audio received so far
  IDENTIFYING: 4,  // phone -> watch: the HTTP request is in flight
  RESULT: 5,       // phone -> watch: TITLE, ARTIST, ALBUM of a match
  NO_MATCH: 6,     // phone -> watch: the service found no match
  ERROR: 7         // phone -> watch: ERROR text to show
};

// Field limits: keep every AppMessage small (watch inbox is 1 KB, buffers are shorter).
var MAX_TITLE = 60;
var MAX_ARTIST = 44;
var MAX_ALBUM = 44;
var MAX_ERROR = 60;

// sirensong error codes -> text shown on the watch. Codes not listed here
// (bad_json, bad_base64, bad_format, bad_pcm_params) mean this app sent a
// malformed request and are shown as "Error: <code>".
var ERROR_TEXT = {
  rate_limited: 'Busy, try again in a minute',
  bad_audio: 'Could not process the audio',
  too_large: 'Recording too large',
  no_audio: 'No audio received',
  upstream_timeout: 'Timed out',
  upstream_error: 'Service unavailable',
  upstream_unavailable: 'Service unavailable',
  upstream_bad_response: 'Service unavailable'
};

function log() {
  var parts = Array.prototype.slice.call(arguments).map(function (a) {
    return typeof a === 'string' ? a : JSON.stringify(a);
  });
  console.log('[whatsplaying] ' + parts.join(' '));
}

function clip(text, max) {
  text = (text === null || text === undefined) ? '' : String(text);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

function storageGet(key, fallback) {
  try {
    var value = localStorage.getItem(key);
    return (value === null || value === undefined || value === '') ? fallback : value;
  } catch (e) {
    log('localStorage read failed:', String(e));
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    log('localStorage write failed:', String(e));
  }
}

// ---------------------------------------------------------------------------
// Outbound AppMessage queue: one message in flight at a time, next one only
// after the ACK (or after giving up on it).
// ---------------------------------------------------------------------------

var outbox = [];
var outboxBusy = false;

function send(message) {
  outbox.push(message);
  pumpOutbox();
}

function pumpOutbox() {
  if (outboxBusy || outbox.length === 0) {
    return;
  }
  outboxBusy = true;
  var message = outbox[0];
  var attempts = 0;

  function done() {
    outbox.shift();
    outboxBusy = false;
    pumpOutbox();
  }

  function attempt() {
    attempts++;
    Pebble.sendAppMessage(message, done, function (e) {
      var reason = e && e.error ? e.error.message : 'nack';
      if (attempts < 3) {
        log('AppMessage failed (' + reason + '), retrying', message.CMD);
        setTimeout(attempt, 300 * attempts);
      } else {
        log('AppMessage dropped after', attempts, 'attempts:', message);
        done();
      }
    });
  }

  attempt();
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function loadHistory() {
  try {
    var parsed = JSON.parse(storageGet(HISTORY_KEY, '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveHistory(history) {
  storageSet(HISTORY_KEY, JSON.stringify(history));
}

function addToHistory(entry) {
  var history = loadHistory();
  history.unshift(entry);
  if (history.length > HISTORY_MAX) {
    history.length = HISTORY_MAX;
  }
  saveHistory(history);
  return history;
}

var lastHistorySentAt = 0;

// One AppMessage per row, newest first. TOTAL = 0 tells the watch to clear.
function sendHistory(force) {
  var now = Date.now();
  if (!force && now - lastHistorySentAt < 2000) {
    return;  // `ready` and the watch's hello usually arrive back to back
  }
  lastHistorySentAt = now;

  var history = loadHistory();
  if (history.length === 0) {
    send({ CMD: CMD.HISTORY, INDEX: 0, TOTAL: 0 });
    return;
  }
  history.forEach(function (entry, index) {
    send({
      CMD: CMD.HISTORY,
      INDEX: index,
      TOTAL: history.length,
      TITLE: clip(entry.title, MAX_TITLE),
      ARTIST: clip(entry.artist, MAX_ARTIST),
      ALBUM: clip(entry.album, MAX_ALBUM)
    });
  });
}

// ---------------------------------------------------------------------------
// Audio capture
// ---------------------------------------------------------------------------

var capture = null;  // { chunks: [Uint8Array], bytes, sampleRate, secondsSent }

function newCapture(sampleRate) {
  return {
    chunks: [],
    bytes: 0,
    sampleRate: sampleRate || DEFAULT_SAMPLE_RATE,
    secondsSent: 0
  };
}

function bytesPerSecond(c) {
  return c.sampleRate * BYTES_PER_SAMPLE;
}

Pebble.addEventListener('audiostreamstart', function (e) {
  log('audiostreamstart', { sampleRate: e.sampleRate, format: e.format });
  if (e.format && e.format !== 'pcm16le') {
    log('Unexpected format', e.format, '- treating as pcm16le');
  }
  capture = newCapture(e.sampleRate);
});

// `data` is an ArrayBuffer of 16-bit little-endian PCM.
Pebble.addEventListener('audiostream', function (e) {
  if (!(e.data instanceof ArrayBuffer)) {
    log('audiostream without ArrayBuffer data');
    return;
  }
  if (!capture) {
    // Missed the start event (e.g. JS restarted mid-stream): start collecting anyway.
    log('audiostream before audiostreamstart');
    capture = newCapture(e.sampleRate);
  }
  var bytes = new Uint8Array(e.data);
  capture.chunks.push(bytes);
  capture.bytes += bytes.length;

  var seconds = Math.floor(capture.bytes / bytesPerSecond(capture));
  if (seconds > capture.secondsSent) {
    capture.secondsSent = seconds;
    send({ CMD: CMD.PROGRESS, SECONDS: seconds });
  }
});

// Whatever ended the stream (the watch's 10 s timer, SELECT, focus lost, the
// phone), this is the signal to identify — if there is enough audio.
Pebble.addEventListener('audiostreamstop', function () {
  var c = capture;
  capture = null;
  if (!c) {
    log('audiostreamstop without any audio');
    return;
  }
  var seconds = c.bytes / bytesPerSecond(c);
  log('audiostreamstop after', seconds.toFixed(1), 's (' + c.bytes + ' bytes)');
  if (seconds < MIN_SECONDS) {
    send({ CMD: CMD.ERROR, ERROR: 'Too short' });
    return;
  }
  identify(c);
});

function joinChunks(c) {
  var pcm = new Uint8Array(c.bytes);
  var offset = 0;
  for (var i = 0; i < c.chunks.length; i++) {
    pcm.set(c.chunks[i], offset);
    offset += c.chunks[i].length;
  }
  return pcm;
}

// ---------------------------------------------------------------------------
// Base64. The request is JSON, so the body is plain ASCII and needs no binary
// support from the runtime's XMLHttpRequest.
// ---------------------------------------------------------------------------

var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBinaryString(bytes) {
  var parts = [];
  var CHUNK = 8192;
  for (var i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return parts.join('');
}

// btoa is not available in every pkjs runtime; fall back to a JS encoder.
function base64Encode(bytes) {
  if (typeof btoa === 'function') {
    try {
      return btoa(bytesToBinaryString(bytes));
    } catch (e) {
      log('btoa failed (' + e + '), using the JS encoder');
    }
  }
  var out = [];
  var i;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] +
             B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63]);
  }
  if (bytes.length - i === 1) {
    var a = bytes[i] << 16;
    out.push(B64_CHARS[(a >> 18) & 63] + B64_CHARS[(a >> 12) & 63] + '==');
  } else if (bytes.length - i === 2) {
    var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out.push(B64_CHARS[(b >> 18) & 63] + B64_CHARS[(b >> 12) & 63] +
             B64_CHARS[(b >> 6) & 63] + '=');
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

function identify(c) {
  send({ CMD: CMD.IDENTIFYING });

  var pcm = joinChunks(c);
  var body = JSON.stringify({
    audio: base64Encode(pcm),
    format: 'pcm',
    sampleRate: c.sampleRate,
    channels: 1,
    bitsPerSample: 16
  });

  log('POST', SIRENSONG_URL, '(' + pcm.length + ' byte PCM, ' + body.length + ' byte body)');

  var xhr = new XMLHttpRequest();
  var finished = false;
  var timer = null;
  function finish(fn) {
    if (!finished) {
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      fn();
    }
  }

  xhr.open('POST', SIRENSONG_URL, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  try {
    xhr.timeout = REQUEST_TIMEOUT_MS;
  } catch (e) { /* not supported everywhere */ }

  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) {
      return;
    }
    finish(function () {
      var text = xhr.responseText || '';
      log('HTTP', xhr.status, text.length > 600 ? text.slice(0, 600) + '…' : text);
      if (xhr.status === 0) {
        send({ CMD: CMD.ERROR, ERROR: 'Network error' });
        return;
      }
      handleResponse(xhr.status, text);
    });
  };
  xhr.onerror = function () {
    finish(function () {
      log('Request error');
      send({ CMD: CMD.ERROR, ERROR: 'Network error' });
    });
  };
  function timedOut() {
    finish(function () {
      log('Request timed out');
      send({ CMD: CMD.ERROR, ERROR: 'Timed out' });
    });
  }
  xhr.ontimeout = timedOut;
  // Backstop for runtimes that ignore xhr.timeout.
  timer = setTimeout(function () {
    timedOut();
    try { xhr.abort(); } catch (e) { /* ignore */ }
  }, REQUEST_TIMEOUT_MS + 1000);

  xhr.send(body);
}

// sirensong answers with {"status":"match"|"no_match"|"error", ...} on every
// status code, including errors.
function handleResponse(httpStatus, text) {
  var json = null;
  try {
    json = JSON.parse(text);
  } catch (e) { /* handled below */ }

  if (!json || typeof json.status !== 'string') {
    var ok = httpStatus >= 200 && httpStatus < 300;
    send({ CMD: CMD.ERROR, ERROR: ok ? 'Bad response' : 'HTTP ' + httpStatus });
    return;
  }

  if (json.status === 'no_match') {
    send({ CMD: CMD.NO_MATCH });
    return;
  }

  if (json.status !== 'match') {
    var code = json.error || 'HTTP ' + httpStatus;
    log('Service error', httpStatus, code);
    send({ CMD: CMD.ERROR, ERROR: clip(ERROR_TEXT[code] || 'Error: ' + code, MAX_ERROR) });
    return;
  }

  var entry = {
    time: new Date().toISOString(),
    title: json.title || '',
    artist: json.artist || '',
    album: json.album || '',
    release_date: json.releaseDate || '',
    song_link: json.songLink || ''
  };
  log('Match:', entry);
  addToHistory(entry);

  send({
    CMD: CMD.RESULT,
    TITLE: clip(entry.title, MAX_TITLE),
    ARTIST: clip(entry.artist, MAX_ARTIST),
    ALBUM: clip(entry.album, MAX_ALBUM)
  });
  sendHistory(true);
}

// ---------------------------------------------------------------------------
// Pebble events
// ---------------------------------------------------------------------------

Pebble.addEventListener('ready', function () {
  log('ready; service =', SIRENSONG_URL);
  sendHistory(false);
});

Pebble.addEventListener('appmessage', function (e) {
  var payload = e && e.payload ? e.payload : {};
  if (payload.CMD === CMD.HELLO) {
    sendHistory(false);
  }
});
