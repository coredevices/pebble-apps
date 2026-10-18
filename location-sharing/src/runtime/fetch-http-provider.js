'use strict';
// Same request/response contract as imessage XhrHttpProvider, over the host's fetch().
var errors = require('../../../chat/imessage/src/runtime/errors');
var bytes = require('../../../chat/imessage/src/runtime/bytes');

var TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function transportError(code, message) {
  return new errors.RuntimeError(code, message, { kind: errors.ERROR_KINDS.TRANSPORT, retryable: true });
}

function validHeader(header) {
  return Array.isArray(header) && header.length === 2 && typeof header[0] === 'string' && TOKEN.test(header[0])
    && typeof header[1] === 'string' && !/[\r\n]/.test(header[1]);
}

function responseBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response body was not binary data.');
}

function FetchHttpProvider(fetchFunction, timer, defaultTimeoutMillis) {
  if (typeof fetchFunction !== 'function') throw new TypeError('fetch is unavailable.');
  if (!timer || typeof timer.after !== 'function' || typeof timer.cancel !== 'function') {
    throw new TypeError('HTTP timer service is unavailable.');
  }
  if (defaultTimeoutMillis === undefined) defaultTimeoutMillis = 20000;
  if (!Number.isSafeInteger(defaultTimeoutMillis) || defaultTimeoutMillis <= 0) {
    throw new TypeError('HTTP timeout is invalid.');
  }
  this.fetchFunction = fetchFunction;
  this.timer = timer;
  this.defaultTimeoutMillis = defaultTimeoutMillis;
}

FetchHttpProvider.prototype.request = function (request) {
  if (!request || typeof request !== 'object' || typeof request.method !== 'string'
      || typeof request.url !== 'string' || !Array.isArray(request.headers)
      || !(request.body instanceof Uint8Array)) {
    return Promise.reject(new TypeError('HTTP request is malformed.'));
  }
  if (!request.headers.every(validHeader)) {
    return Promise.reject(new TypeError('HTTP request contains an invalid header.'));
  }
  var timeoutMillis = request.timeoutMillis === undefined ? this.defaultTimeoutMillis : request.timeoutMillis;
  if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis <= 0) {
    return Promise.reject(new TypeError('HTTP request timeout is invalid.'));
  }
  var maxResponseBytes = request.maxResponseBytes;
  if (maxResponseBytes !== undefined
      && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > 64 * 1024 * 1024)) {
    return Promise.reject(new TypeError('HTTP response byte limit is invalid.'));
  }
  var headers = Object.create(null);
  request.headers.forEach(function (header) {
    headers[header[0]] = header[0] in headers ? headers[header[0]] + ', ' + header[1] : header[1];
  });
  var fetchFunction = this.fetchFunction;
  var timer = this.timer;
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timeoutHandle = null;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) {
        try { timer.cancel(timeoutHandle); } catch (_) { /* a settled response remains authoritative */ }
      }
      if (error) reject(error); else resolve(value);
    }
    var pending;
    try {
      timeoutHandle = timer.after(timeoutMillis, function () {
        finish(transportError('HTTP_TIMEOUT', 'HTTP request timed out.'));
      });
      pending = Promise.resolve(fetchFunction(request.url, {
        method: request.method,
        headers: headers,
        // Stock CoreApp's fetch only sends text bodies; Google's requests are all text.
        body: request.body.length > 0 ? bytes.bytesToUtf8(request.body) : undefined,
        responseType: 'arraybuffer',
      }));
    } catch (_) {
      finish(transportError('HTTP_NETWORK_ERROR', 'HTTP request could not be started.'));
      return;
    }
    pending.then(function (response) {
      if (settled) return undefined;
      if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response status was invalid.');
      }
      var responseHeaders = [];
      response.headers.forEach(function (value, name) {
        var header = [String(name).toLowerCase(), String(value)];
        if (!validHeader(header)) throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response contained an invalid header.');
        responseHeaders.push(Object.freeze(header));
      });
      return response.arrayBuffer().then(function (buffer) {
        var body = responseBytes(buffer);
        if (maxResponseBytes !== undefined && body.length > maxResponseBytes) {
          throw transportError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response exceeded its byte limit.');
        }
        finish(null, Object.freeze({ status: response.status, headers: Object.freeze(responseHeaders), body: body }));
      });
    }).then(null, function (error) {
      finish(error instanceof errors.RuntimeError ? error : transportError('HTTP_NETWORK_ERROR', 'HTTP request failed.'));
    });
  });
};

module.exports = { FetchHttpProvider: FetchHttpProvider };
