'use strict';

var apsBag = require('../aps/bag');
var bagTrust = require('./bag-trust');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var ENDPOINT_KEYS = Object.freeze({
  authenticationEndpoint: 'id-authenticate-ds-id',
  handlesEndpoint: 'id-get-handles',
  registrationEndpoint: 'id-register',
  lookupEndpoint: 'id-query',
  validationCertificateEndpoint: 'id-validation-cert',
  validationInitializationEndpoint: 'id-initialize-validation',
});

function protocolError(message, details) {
  return new RuntimeError('IDS_BAG_INVALID', message, {
    kind: ERROR_KINDS.TRANSPORT,
    retryable: true,
    details: details,
  });
}

function trace(effects, kind) {
  if (!effects.trace || typeof effects.trace.emit !== 'function') return;
  try { effects.trace.emit(Object.freeze({ kind: kind })); }
  catch (_) { /* diagnostics must never change endpoint discovery behavior */ }
}

function validateAppleEndpoint(value, key) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
      || /[\u0000-\u0020\u007f@\\]/.test(value)) {
    throw protocolError('The IDS bag contains a malformed endpoint.', { bagKey: key });
  }
  if (key === ENDPOINT_KEYS.validationCertificateEndpoint
      && /^http:\/\/static\.ess\.apple\.com\//i.test(value)) {
    value = 'https://' + value.slice('http://'.length);
  }
  var match = value.match(/^https:\/\/([^/?#]+)(\/[^#]*)?$/i);
  if (!match || !/(^|\.)apple\.com$/i.test(match[1])) {
    throw protocolError('The IDS bag contains an untrusted endpoint.', { bagKey: key });
  }
  return value;
}

function endpointsFromBag(bag) {
  var result = {};
  Object.keys(ENDPOINT_KEYS).forEach(function (name) {
    var key = ENDPOINT_KEYS[name];
    var value;
    try { value = apsBag.getBagValue(bag, key); }
    catch (_) { throw protocolError('The IDS bag is missing a required endpoint.', { bagKey: key }); }
    result[name] = validateAppleEndpoint(value, key);
  });
  return Object.freeze(result);
}

async function fetchIdsEndpoints(effects) {
  if (!effects || !effects.http || typeof effects.http.request !== 'function') {
    throw new TypeError('IDS HTTP effects are unavailable.');
  }
  var response;
  try {
    var request = apsBag.buildBagRequest(apsBag.IDS_BAG_URL);
    response = await effects.http.request(Object.freeze({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
      trustAnchors: Object.freeze(bagTrust.bagTrustAnchors()),
      timeoutMillis: 20000,
      maxResponseBytes: 2 * 1024 * 1024,
    }));
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw protocolError('The IDS bag request failed.');
  }
  if (!response || !Number.isSafeInteger(response.status)
      || !(response.body instanceof Uint8Array)) {
    throw protocolError('The IDS bag request returned a malformed response.');
  }
  if (response.status < 200 || response.status >= 300) {
    trace(effects, 'configuration.ids-bag-http-' + response.status);
    throw protocolError('The IDS bag request was rejected.', { httpStatus: response.status });
  }
  trace(effects, 'configuration.ids-bag-response-' + response.status + '-' + response.body.length);
  try {
    var endpoints = endpointsFromBag(apsBag.parseBagResponse(response.body));
    trace(effects, 'configuration.ids-bag-decoded');
    return endpoints;
  }
  catch (error) {
    trace(effects, 'configuration.ids-bag-decode-error');
    if (error instanceof RuntimeError && error.code === 'IDS_BAG_INVALID') throw error;
    throw protocolError('The IDS bag response could not be decoded.');
  }
}

module.exports = {
  ENDPOINT_KEYS: ENDPOINT_KEYS,
  endpointsFromBag: endpointsFromBag,
  fetchIdsEndpoints: fetchIdsEndpoints,
  validateAppleEndpoint: validateAppleEndpoint,
};
