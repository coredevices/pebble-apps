'use strict';

var bytes = require('./bytes');
var RuntimeError = require('./errors').RuntimeError;
var ERROR_KINDS = require('./errors').ERROR_KINDS;

function transportError(code, message) {
  return new RuntimeError(code, message, { kind: ERROR_KINDS.TRANSPORT, retryable: true });
}

function validateHeader(header) {
  return Array.isArray(header) && header.length === 2
    && typeof header[0] === 'string'
    && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header[0])
    && typeof header[1] === 'string'
    && !/[\r\n]/.test(header[1]);
}

function responseBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (value && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response body was not binary data.');
}

function responseByteLength(value) {
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value.byteLength;
  if (value && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return value.byteLength;
  throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response body was not binary data.');
}

function parseResponseHeaders(xhr) {
  if (Array.isArray(xhr._responseHeaderEntries)) {
    return xhr._responseHeaderEntries.map(function (header) {
      if (!validateHeader(header)) {
        throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response contained an invalid header.');
      }
      return Object.freeze([String(header[0]).toLowerCase(), String(header[1])]);
    });
  }
  var raw = typeof xhr.getAllResponseHeaders === 'function' ? xhr.getAllResponseHeaders() : '';
  if (!raw) return [];
  var result = [];
  raw.split(/\r?\n/).forEach(function (line) {
    if (!line) return;
    var separator = line.indexOf(':');
    var header = separator === -1 ? null : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    if (!header || !validateHeader(header)) {
      throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response contained an invalid header.');
    }
    result.push(Object.freeze([header[0].toLowerCase(), header[1]]));
  });
  return result;
}

/** Promise-based binary HTTP effect over the plugin host's generic XMLHttpRequest surface. */
function XhrHttpProvider(XMLHttpRequestConstructor, timer, defaultTimeoutMillis) {
  if (typeof XMLHttpRequestConstructor !== 'function') {
    throw new TypeError('XMLHttpRequest is unavailable.');
  }
  if (!timer || typeof timer.after !== 'function' || typeof timer.cancel !== 'function') {
    throw new TypeError('HTTP timer service is unavailable.');
  }
  if (defaultTimeoutMillis === undefined) defaultTimeoutMillis = 20000;
  if (!Number.isSafeInteger(defaultTimeoutMillis) || defaultTimeoutMillis <= 0) {
    throw new TypeError('HTTP timeout is invalid.');
  }
  this.XMLHttpRequest = XMLHttpRequestConstructor;
  this.timer = timer;
  this.defaultTimeoutMillis = defaultTimeoutMillis;
}

XhrHttpProvider.prototype.request = function (request) {
  if (!request || typeof request !== 'object' || typeof request.method !== 'string'
      || typeof request.url !== 'string' || !Array.isArray(request.headers)
      || !(request.body instanceof Uint8Array)) {
    return Promise.reject(new TypeError('HTTP request is malformed.'));
  }
  for (var index = 0; index < request.headers.length; index += 1) {
    if (!validateHeader(request.headers[index])) {
      return Promise.reject(new TypeError('HTTP request contains an invalid header.'));
    }
  }
  var Constructor = this.XMLHttpRequest;
  var timer = this.timer;
  var timeoutMillis = request.timeoutMillis === undefined
    ? this.defaultTimeoutMillis : request.timeoutMillis;
  if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis <= 0) {
    return Promise.reject(new TypeError('HTTP request timeout is invalid.'));
  }
  var maxResponseBytes = request.maxResponseBytes;
  if (maxResponseBytes !== undefined
      && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > 64 * 1024 * 1024)) {
    return Promise.reject(new TypeError('HTTP response byte limit is invalid.'));
  }
  return new Promise(function (resolve, reject) {
    var xhr = new Constructor();
    var settled = false;
    var timeoutHandle = null;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) {
        try { timer.cancel(timeoutHandle); } catch (_) { /* a settled response remains authoritative */ }
        timeoutHandle = null;
      }
      if (error) reject(error); else resolve(value);
    }
    xhr.responseType = 'arraybuffer';
    // CoreApp's generic XHR bridge enforces this while streaming; browser XHRs also get the
    // progress/final checks below. This carries only a byte budget, never protocol policy.
    xhr.maxResponseBytes = maxResponseBytes === undefined ? null : maxResponseBytes;
    xhr.onprogress = function (event) {
      if (settled || maxResponseBytes === undefined || !event
          || !Number.isSafeInteger(event.loaded) || event.loaded <= maxResponseBytes) return;
      finish(transportError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response exceeded its byte limit.'));
      try { xhr.abort(); } catch (_) { /* size failure remains authoritative */ }
    };
    xhr.onload = function () {
      try {
        if (!Number.isInteger(xhr.status) || xhr.status < 100 || xhr.status > 599) {
          throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response status was invalid.');
        }
        if (maxResponseBytes !== undefined && responseByteLength(xhr.response) > maxResponseBytes) {
          throw transportError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response exceeded its byte limit.');
        }
        finish(null, Object.freeze({
          status: xhr.status,
          headers: Object.freeze(parseResponseHeaders(xhr)),
          body: responseBytes(xhr.response),
        }));
      } catch (error) { finish(error); }
    };
    xhr.onerror = function () {
      finish(transportError(xhr._responseTooLarge === true ? 'HTTP_RESPONSE_TOO_LARGE' : 'HTTP_NETWORK_ERROR',
        xhr._responseTooLarge === true ? 'HTTP response exceeded its byte limit.' : 'HTTP request failed.'));
    };
    xhr.ontimeout = function () { finish(transportError('HTTP_TIMEOUT', 'HTTP request timed out.')); };
    xhr.onabort = function () { finish(transportError('HTTP_ABORTED', 'HTTP request was cancelled.')); };
    try {
      xhr.open(request.method, request.url, true);
      request.headers.forEach(function (header) { xhr.setRequestHeader(header[0], header[1]); });
      timeoutHandle = timer.after(timeoutMillis, function () {
        if (settled) return;
        finish(transportError('HTTP_TIMEOUT', 'HTTP request timed out.'));
        try { xhr.abort(); } catch (_) { /* timeout remains authoritative */ }
      });
      xhr.send(new Uint8Array(request.body));
    } catch (error) {
      finish(transportError('HTTP_NETWORK_ERROR', 'HTTP request could not be started.'));
    }
  });
};

function LocalStorageProvider(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function'
      || typeof storage.removeItem !== 'function') throw new TypeError('Plugin storage is unavailable.');
  this.storage = storage;
}
LocalStorageProvider.prototype.get = function (key) { return this.storage.getItem(key); };
LocalStorageProvider.prototype.set = function (key, value) { this.storage.setItem(key, value); };
LocalStorageProvider.prototype.delete = function (key) { this.storage.removeItem(key); };

function createClockProvider() {
  return Object.freeze({ now: function () { return Date.now(); } });
}

function createRandomProvider(crypto) {
  if (!crypto || typeof crypto.random !== 'function') throw new TypeError('Crypto random source is unavailable.');
  return Object.freeze({ bytes: function (length) { return crypto.random(length); } });
}

function createTraceProvider(consoleObject) {
  return Object.freeze({
    emit: function (event) {
      if (consoleObject && typeof consoleObject.info === 'function') {
        consoleObject.info('[iMessage state]', event && event.kind ? event.kind : 'event');
      }
    },
  });
}

module.exports = {
  LocalStorageProvider: LocalStorageProvider,
  XhrHttpProvider: XhrHttpProvider,
  createClockProvider: createClockProvider,
  createRandomProvider: createRandomProvider,
  createTraceProvider: createTraceProvider,
  parseResponseHeaders: parseResponseHeaders,
};
