'use strict';

var bytes = require('./bytes');
var gzipCodec = require('../codecs/gzip');
var RuntimeError = require('./errors').RuntimeError;
var ERROR_KINDS = require('./errors').ERROR_KINDS;

var MAX_HEADER_BYTES = 64 * 1024;
var DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function transportError(code, message) {
  return new RuntimeError(code, message, { kind: ERROR_KINDS.TRANSPORT, retryable: true });
}

function emitTrace(trace, kind) {
  if (typeof trace !== 'function') return;
  try { trace(kind); } catch (_) { /* diagnostics must never change transport behavior */ }
}

function validateHeader(header) {
  return Array.isArray(header) && header.length === 2
    && typeof header[0] === 'string'
    && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header[0])
    && typeof header[1] === 'string'
    && !/[\r\n]/.test(header[1]);
}

function parseHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new TypeError('HTTPS URL is invalid.');
  var match = value.match(/^https:\/\/([^\/:?#]+)(?::([0-9]{1,5}))?([^#]*)$/);
  if (!match || !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(match[1])) {
    throw new TypeError('HTTPS URL is invalid.');
  }
  var port = match[2] === undefined ? 443 : Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('HTTPS port is invalid.');
  var path = match[3] || '/';
  if (path[0] !== '/' || /[\r\n]/.test(path)) throw new TypeError('HTTPS path is invalid.');
  return Object.freeze({ host: match[1], port: port, path: path });
}

function ascii(value) {
  var result = '';
  for (var index = 0; index < value.length; index += 1) {
    if (value[index] > 0x7f) throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response headers were not ASCII.');
    result += String.fromCharCode(value[index]);
  }
  return result;
}

function findHeaderEnd(value) {
  var limit = Math.min(value.length - 3, MAX_HEADER_BYTES);
  for (var index = 0; index < limit; index += 1) {
    if (value[index] === 13 && value[index + 1] === 10
        && value[index + 2] === 13 && value[index + 3] === 10) return index;
  }
  return -1;
}

function concatChunks(chunks, length) {
  var result = new Uint8Array(length);
  var offset = 0;
  chunks.forEach(function (chunk) { result.set(chunk, offset); offset += chunk.length; });
  return result;
}

function decodeChunkedBody(value, maxResponseBytes) {
  var output = [];
  var outputLength = 0;
  var offset = 0;
  while (true) {
    var lineEnd = -1;
    for (var index = offset; index + 1 < value.length; index += 1) {
      if (value[index] === 13 && value[index + 1] === 10) { lineEnd = index; break; }
    }
    if (lineEnd < 0 || lineEnd - offset > 128) {
      throw transportError('HTTP_INVALID_RESPONSE', 'Chunked HTTP response was malformed.');
    }
    var sizeText = ascii(value.slice(offset, lineEnd)).split(';')[0];
    if (!/^[0-9A-Fa-f]+$/.test(sizeText)) {
      throw transportError('HTTP_INVALID_RESPONSE', 'Chunked HTTP response size was invalid.');
    }
    var size = parseInt(sizeText, 16);
    offset = lineEnd + 2;
    if (size === 0) {
      // A zero chunk is followed by optional trailers and one terminating empty line.
      if (offset + 2 > value.length) throw transportError('HTTP_INVALID_RESPONSE', 'Chunked HTTP response was truncated.');
      return concatChunks(output, outputLength);
    }
    if (!Number.isSafeInteger(size) || size > maxResponseBytes - outputLength
        || offset + size + 2 > value.length
        || value[offset + size] !== 13 || value[offset + size + 1] !== 10) {
      throw transportError(size > maxResponseBytes - outputLength ? 'HTTP_RESPONSE_TOO_LARGE' : 'HTTP_INVALID_RESPONSE',
        size > maxResponseBytes - outputLength ? 'HTTP response exceeded its byte limit.' : 'Chunked HTTP response was truncated.');
    }
    output.push(value.slice(offset, offset + size));
    outputLength += size;
    offset += size + 2;
  }
}

function decodeContentEncoding(headers, body, maxResponseBytes) {
  var contentEncoding = headers.filter(function (header) { return header[0] === 'content-encoding'; });
  if (contentEncoding.length === 0
      || (contentEncoding.length === 1 && contentEncoding[0][1].toLowerCase() === 'identity')) {
    return body;
  }
  if (contentEncoding.length !== 1 || contentEncoding[0][1].toLowerCase() !== 'gzip') {
    throw transportError('HTTP_INVALID_RESPONSE', 'HTTP content encoding is unsupported.');
  }
  try {
    return gzipCodec.ungzip(body, {
      maxInputBytes: maxResponseBytes,
      maxOutputBytes: maxResponseBytes,
    });
  } catch (_) {
    throw transportError('HTTP_INVALID_RESPONSE', 'Gzip HTTP response body was invalid or too large.');
  }
}

function parseResponse(value, maxResponseBytes) {
  var headerEnd = findHeaderEnd(value);
  if (headerEnd < 0) throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response headers were malformed or too large.');
  var lines = ascii(value.slice(0, headerEnd)).split('\r\n');
  var statusMatch = lines.shift().match(/^HTTP\/1\.[01] ([1-5][0-9]{2})(?: .*)?$/);
  if (!statusMatch) throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response status was invalid.');
  var headers = [];
  lines.forEach(function (line) {
    var separator = line.indexOf(':');
    var header = separator < 1 ? null : [line.slice(0, separator), line.slice(separator + 1).trim()];
    if (!header || !validateHeader(header)) {
      throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response contained an invalid header.');
    }
    headers.push(Object.freeze([header[0].toLowerCase(), header[1]]));
  });
  var body = value.slice(headerEnd + 4);
  var transferEncoding = headers.filter(function (header) { return header[0] === 'transfer-encoding'; });
  var contentLength = headers.filter(function (header) { return header[0] === 'content-length'; });
  if (transferEncoding.length > 0) {
    if (transferEncoding.length !== 1 || transferEncoding[0][1].toLowerCase() !== 'chunked') {
      throw transportError('HTTP_INVALID_RESPONSE', 'HTTP transfer encoding is unsupported.');
    }
    body = decodeChunkedBody(body, maxResponseBytes);
  } else if (contentLength.length > 0) {
    if (contentLength.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(contentLength[0][1])) {
      throw transportError('HTTP_INVALID_RESPONSE', 'HTTP content length was invalid.');
    }
    var expectedLength = Number(contentLength[0][1]);
    if (!Number.isSafeInteger(expectedLength) || expectedLength !== body.length) {
      throw transportError('HTTP_INVALID_RESPONSE', 'HTTP response body was truncated.');
    }
  }
  if (body.length > maxResponseBytes) {
    throw transportError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response exceeded its byte limit.');
  }
  body = decodeContentEncoding(headers, body, maxResponseBytes);
  return Object.freeze({
    status: Number(statusMatch[1]),
    headers: Object.freeze(headers),
    body: new Uint8Array(body),
  });
}

function buildRequest(request, target) {
  if (!request || typeof request !== 'object' || !/^[A-Z]+$/.test(request.method)
      || !Array.isArray(request.headers) || !(request.body instanceof Uint8Array)) {
    throw new TypeError('HTTP request is malformed.');
  }
  var reserved = { host: true, connection: true, 'content-length': true, 'transfer-encoding': true };
  request.headers.forEach(function (header) {
    if (!validateHeader(header) || reserved[header[0].toLowerCase()]) {
      throw new TypeError('HTTP request contains an invalid or reserved header.');
    }
  });
  var lines = [
    request.method + ' ' + target.path + ' HTTP/1.1',
    'Host: ' + target.host + (target.port === 443 ? '' : ':' + target.port),
    'Connection: close',
  ];
  if (!request.headers.some(function (header) { return header[0].toLowerCase() === 'accept-encoding'; })) {
    lines.push('Accept-Encoding: identity');
  }
  lines.push('Content-Length: ' + request.body.length);
  request.headers.forEach(function (header) { lines.push(header[0] + ': ' + header[1]); });
  lines.push('', '');
  return bytes.concatBytes(bytes.utf8ToBytes(lines.join('\r\n')), request.body);
}

function requestOverTls(tls, timer, request, trace) {
  var target;
  var wire;
  try {
    target = parseHttpsUrl(request.url);
    wire = buildRequest(request, target);
  } catch (error) {
    emitTrace(trace, 'http.tls.validation-error');
    return Promise.reject(error);
  }
  var anchors = request.trustAnchors;
  if (!Array.isArray(anchors) || anchors.length === 0
      || anchors.some(function (anchor) { return !(anchor instanceof Uint8Array) || anchor.length === 0; })) {
    return Promise.reject(new TypeError('HTTPS trust anchors are invalid.'));
  }
  var timeoutMillis = request.timeoutMillis === undefined ? 20000 : request.timeoutMillis;
  var maxResponseBytes = request.maxResponseBytes === undefined
    ? DEFAULT_MAX_RESPONSE_BYTES : request.maxResponseBytes;
  if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis < 1000 || timeoutMillis > 120000
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024) {
    return Promise.reject(new TypeError('HTTPS request limits are invalid.'));
  }
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var length = 0;
    var socket = null;
    var settled = false;
    var timeoutHandle = null;
    function finish(error, value, closeSocket) {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) {
        try { timer.cancel(timeoutHandle); } catch (_) { /* the terminal result remains authoritative */ }
      }
      if (closeSocket && socket) {
        try { socket.close(); } catch (_) { /* the original failure remains authoritative */ }
      }
      if (error) reject(error); else resolve(value);
    }
    try {
      emitTrace(trace, 'http.tls.opening');
      socket = tls.open({
        host: target.host,
        port: target.port,
        serverName: target.host,
        alpn: ['http/1.1'],
        trustAnchors: anchors,
        connectTimeoutMillis: timeoutMillis,
      }, function (event) {
        if (settled || !event || typeof event.type !== 'string') return;
        if (event.type === 'open') {
          emitTrace(trace, 'http.tls.open');
          try { socket.write(wire); emitTrace(trace, 'http.tls.written'); }
          catch (_) {
            emitTrace(trace, 'http.tls.write-error');
            finish(transportError('HTTP_NETWORK_ERROR', 'HTTPS request could not be written.'), null, true);
          }
          return;
        }
        if (event.type === 'data') {
          if (!(event.data instanceof Uint8Array)) {
            finish(transportError('HTTP_INVALID_RESPONSE', 'HTTPS transport returned invalid data.'), null, true);
            return;
          }
          if (chunks.length === 0) emitTrace(trace, 'http.tls.first-data');
          length += event.data.length;
          if (length > maxResponseBytes + MAX_HEADER_BYTES) {
            finish(transportError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response exceeded its byte limit.'), null, true);
            return;
          }
          chunks.push(new Uint8Array(event.data));
          return;
        }
        if (event.type === 'error') {
          emitTrace(trace, 'http.tls.transport-error');
          finish(transportError('HTTP_NETWORK_ERROR', 'HTTPS transport failed.'), null, true);
          return;
        }
        if (event.type === 'close') {
          emitTrace(trace, 'http.tls.close');
          try {
            var response = parseResponse(concatChunks(chunks, length), maxResponseBytes);
            emitTrace(trace, 'http.tls.complete');
            finish(null, response, false);
          } catch (error) {
            emitTrace(trace, 'http.tls.parse-error');
            finish(error, null, false);
          }
        }
      });
      emitTrace(trace, 'http.tls.handle-opened');
      timeoutHandle = timer.after(timeoutMillis, function () {
        emitTrace(trace, 'http.tls.timeout');
        finish(transportError('HTTP_TIMEOUT', 'HTTPS request timed out.'), null, true);
      });
    } catch (_) {
      emitTrace(trace, 'http.tls.start-error');
      finish(transportError('HTTP_NETWORK_ERROR', 'HTTPS request could not be started.'), null, true);
    }
  });
}

/** Routes requests carrying JS-owned trust anchors through the generic TLS byte stream. */
function TlsRoutingHttpProvider(fallback, tls, timer, trace) {
  if (!fallback || typeof fallback.request !== 'function' || !tls || typeof tls.open !== 'function'
      || !timer || typeof timer.after !== 'function' || typeof timer.cancel !== 'function') {
    throw new TypeError('TLS-routing HTTP dependencies are unavailable.');
  }
  this.fallback = fallback;
  this.tls = tls;
  this.timer = timer;
  this.trace = trace;
}

TlsRoutingHttpProvider.prototype.request = function (request) {
  var target = request && request.method + ' ' + String(request.url).split('?')[0];
  var response = Array.isArray(request && request.trustAnchors) && request.trustAnchors.length > 0
    ? requestOverTls(this.tls, this.timer, request, this.trace)
    : this.fallback.request(request);
  return Promise.resolve(response).then(function (value) {
    if (value && (value.status < 200 || value.status >= 300)) console.error(target + ': HTTP ' + value.status);
    return value;
  }, function (error) {
    console.error(target + ' failed: ' + (error && error.message));
    throw error;
  });
};

module.exports = {
  TlsRoutingHttpProvider: TlsRoutingHttpProvider,
  parseResponse: parseResponse,
  requestOverTls: requestOverTls,
};
