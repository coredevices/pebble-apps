'use strict';

var binaryPlist = require('../codecs/binary-plist');
var xmlPlist = require('../codecs/xml-plist');
var idsBag = require('../ids/bag');
var bagTrust = require('../ids/bag-trust');
var appleTrust = require('../apple/server-trust');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;
var hardwareModule = require('./hardware-environment');
var imageModule = require('./image');
var validationContextModule = require('./validation-context');
var createWorkerContext = require('./worker-context').createWorkerContext;

var CERTIFICATE_BAG_KEY = 'id-validation-cert';
var INITIALIZATION_BAG_KEY = 'id-initialize-validation';
var MAX_PLIST_RESPONSE_BYTES = 2 * 1024 * 1024;
var MAX_PLIST_DATA_BYTES = 1024 * 1024;
var PLIST_LIMITS = Object.freeze({
  maxInputBytes: MAX_PLIST_RESPONSE_BYTES,
  maxOutputBytes: MAX_PLIST_RESPONSE_BYTES,
  maxDepth: 8,
  maxObjects: 64,
  maxNodes: 64,
  maxContainerLength: 32,
  maxStringBytes: 4096,
  maxDataBytes: MAX_PLIST_DATA_BYTES,
});

function validationError(code, message, kind, retryable, details) {
  return new RuntimeError(code, message, {
    kind: kind || ERROR_KINDS.TRANSPORT,
    retryable: retryable === true,
    details: details,
  });
}

function trace(effects, kind) {
  try {
    if (effects && effects.trace && typeof effects.trace.emit === 'function') {
      effects.trace.emit(Object.freeze({ kind: kind }));
    }
  } catch (_) { /* diagnostics must never change validation behavior */ }
}

function requireDependencies(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Mac validation-data options are required.');
  }
  if (!options.effects || !options.effects.http
      || typeof options.effects.http.request !== 'function') {
    throw new TypeError('Mac validation-data HTTP effects are unavailable.');
  }
  if (!options.crypto || typeof options.crypto.digest !== 'function') {
    throw new TypeError('Mac validation-data digest primitive is unavailable.');
  }
  if (!options.machineProvider || typeof options.machineProvider.create !== 'function') {
    throw new TypeError('Mac validation-data x86-64 machine provider is unavailable.');
  }
  if (typeof options.randomWord !== 'function') {
    throw new TypeError('Mac validation-data random-word provider is unavailable.');
  }
  if (!options.endpoints || typeof options.endpoints !== 'object'
      || Array.isArray(options.endpoints)) {
    throw new TypeError('Mac validation-data IDS endpoints are unavailable.');
  }
}

function parsePlist(body, name) {
  if (!(body instanceof Uint8Array) || body.length === 0
      || body.length > MAX_PLIST_RESPONSE_BYTES) {
    throw validationError('NAC_VALIDATION_PROTOCOL_ERROR',
      'The Mac validation ' + name + ' response is malformed.');
  }
  try {
    if (body.length >= 8 && body[0] === 0x62 && body[1] === 0x70
        && body[2] === 0x6c && body[3] === 0x69 && body[4] === 0x73
        && body[5] === 0x74 && body[6] === 0x30 && body[7] === 0x30) {
      return binaryPlist.decodeBinaryPlist(body, PLIST_LIMITS);
    }
    return xmlPlist.decodeXmlPlist(body, PLIST_LIMITS);
  } catch (_) {
    throw validationError('NAC_VALIDATION_PROTOCOL_ERROR',
      'The Mac validation ' + name + ' response is not a valid property list.');
  }
}

function dataField(response, field, name) {
  if (!response || typeof response !== 'object' || Array.isArray(response)
      || response instanceof Uint8Array || !(response[field] instanceof Uint8Array)
      || response[field].length === 0 || response[field].length > MAX_PLIST_DATA_BYTES) {
    throw validationError('NAC_VALIDATION_PROTOCOL_ERROR',
      'The Mac validation ' + name + ' response is malformed.');
  }
  return new Uint8Array(response[field]);
}

function fieldKind(value) {
  if (value === undefined) return 'missing';
  if (value instanceof Uint8Array) return 'bytes';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'other';
}

function buildCertificateRequest(endpoint) {
  return Object.freeze({
    method: 'GET',
    url: idsBag.validateAppleEndpoint(endpoint, CERTIFICATE_BAG_KEY),
    headers: Object.freeze([]),
    body: new Uint8Array(0),
    maxResponseBytes: MAX_PLIST_RESPONSE_BYTES,
    bagKey: CERTIFICATE_BAG_KEY,
    trustAnchors: Object.freeze(bagTrust.bagTrustAnchors()),
  });
}

function buildInitializationRequest(endpoint, sessionInfoRequest) {
  if (!(sessionInfoRequest instanceof Uint8Array) || sessionInfoRequest.length === 0
      || sessionInfoRequest.length > MAX_PLIST_DATA_BYTES) {
    throw validationError('NAC_VALIDATION_PROTOCOL_ERROR',
      'The NAC session-info request is malformed.', ERROR_KINDS.INTERNAL);
  }
  var body;
  try {
    // RustPush and Apple's native flow send this endpoint an XML plist. The service may return
    // HTTP 200 with an error dictionary when handed a binary plist, so keep this wire format exact.
    body = xmlPlist.encodeXmlPlist({
      'session-info-request': new Uint8Array(sessionInfoRequest),
    }, PLIST_LIMITS);
  } catch (_) {
    throw validationError('NAC_VALIDATION_PROTOCOL_ERROR',
      'The NAC session-info request could not be encoded.', ERROR_KINDS.INTERNAL);
  }
  return Object.freeze({
    method: 'POST',
    url: idsBag.validateAppleEndpoint(endpoint, INITIALIZATION_BAG_KEY),
    headers: Object.freeze([]),
    body: body,
    maxResponseBytes: MAX_PLIST_RESPONSE_BYTES,
    bagKey: INITIALIZATION_BAG_KEY,
    trustAnchors: Object.freeze(appleTrust.appleServerTrustAnchors()),
  });
}

function validateHttpResponse(response, stage) {
  if (!response || typeof response !== 'object' || !Number.isSafeInteger(response.status)
      || !(response.body instanceof Uint8Array)
      || response.body.length > MAX_PLIST_RESPONSE_BYTES) {
    throw validationError('NAC_VALIDATION_NETWORK_ERROR',
      'The Mac validation ' + stage + ' transport returned a malformed response.',
      ERROR_KINDS.TRANSPORT, true);
  }
  if (response.status < 200 || response.status >= 300) {
    throw validationError('NAC_VALIDATION_NETWORK_ERROR',
      'The Mac validation ' + stage + ' request was rejected.',
      ERROR_KINDS.TRANSPORT, true, { httpStatus: response.status });
  }
  return response.body;
}

async function request(effects, requestValue, stage) {
  var response;
  try { response = await effects.http.request(requestValue); }
  catch (_) {
    throw validationError('NAC_VALIDATION_NETWORK_ERROR',
      'The Mac validation ' + stage + ' request failed.', ERROR_KINDS.TRANSPORT, true);
  }
  return validateHttpResponse(response, stage);
}

function ValidationDataGenerator(options) {
  requireDependencies(options);
  this.effects = options.effects;
  this.crypto = options.crypto;
  this.machineProvider = options.machineProvider;
  this.workerProvider = options.workerProvider || null;
  this.randomWord = options.randomWord;
  this.certificateEndpoint = idsBag.validateAppleEndpoint(
    options.endpoints.validationCertificateEndpoint, CERTIFICATE_BAG_KEY
  );
  this.initializationEndpoint = idsBag.validateAppleEndpoint(
    options.endpoints.validationInitializationEndpoint, INITIALIZATION_BAG_KEY
  );
  this.verifiedImagePromise = null;
}

ValidationDataGenerator.prototype._loadImage = function () {
  if (this.verifiedImagePromise) return this.verifiedImagePromise;
  var self = this;
  this.verifiedImagePromise = imageModule.loadPinnedImage(this.effects, this.crypto).then(function (image) {
    return new Uint8Array(image);
  }, function (error) {
    self.verifiedImagePromise = null;
    throw error;
  });
  return this.verifiedImagePromise;
};

ValidationDataGenerator.prototype.generate = async function (hardware) {
  // The verified image is immutable compatibility code and may be shared. Everything below it is
  // deliberately recreated for every delegate or registration request.
  var hardwareEnvironment = hardwareModule.createHardwareEnvironment(hardware);
  trace(this.effects, 'nac.image-load-start');
  var image = new Uint8Array(await this._loadImage());
  trace(this.effects, 'nac.image-load-complete-' + image.length);
  trace(this.effects, 'nac.certificate-request-start');
  var certificateBody = await request(
    this.effects, buildCertificateRequest(this.certificateEndpoint), 'certificate'
  );
  trace(this.effects, 'nac.certificate-request-complete-' + certificateBody.length);
  trace(this.effects, 'nac.certificate-parse-start');
  var certificateResponse = parsePlist(certificateBody, 'certificate');
  trace(this.effects, 'nac.certificate-parse-complete');
  trace(this.effects, 'nac.certificate-field-' + fieldKind(certificateResponse.cert));
  var certificate = dataField(certificateResponse, 'cert', 'certificate');
  trace(this.effects, 'nac.certificate-field-complete-' + certificate.length);
  var context = null;
  var primaryError = null;
  try {
    trace(this.effects, 'nac.context-create-start');
    context = this.workerProvider ? await createWorkerContext(this.workerProvider, {
      image: image, certificate: certificate, hardware: hardware,
    }) : validationContextModule.createValidationContext({
      machineProvider: this.machineProvider,
      image: image,
      certificateChain: certificate,
      hardwareEnvironment: hardwareEnvironment,
      randomWord: this.randomWord,
    });
    trace(this.effects, 'nac.context-create-complete');
    trace(this.effects, 'nac.session-info-request-start');
    var initializationBody = await request(this.effects, buildInitializationRequest(
      this.initializationEndpoint, context.sessionInfoRequest
    ), 'session-info');
    trace(this.effects, 'nac.session-info-request-complete-' + initializationBody.length);
    trace(this.effects, 'nac.session-info-parse-start');
    var initializationResponse = parsePlist(initializationBody, 'session-info');
    trace(this.effects, 'nac.session-info-parse-complete');
    trace(this.effects, 'nac.session-info-field-' + fieldKind(initializationResponse['session-info']));
    var sessionInfo = dataField(initializationResponse, 'session-info', 'session-info');
    trace(this.effects, 'nac.session-info-field-complete-' + sessionInfo.length);
    trace(this.effects, 'nac.context-establish-start');
    await context.establish(sessionInfo);
    trace(this.effects, 'nac.context-establish-complete');
    var result = new Uint8Array(await context.sign());
    trace(this.effects, 'nac.sign-complete-' + result.length);
    return result;
  } catch (error) {
    primaryError = error;
    if (error instanceof RuntimeError) throw error;
    throw validationError('NAC_VALIDATION_FAILED',
      'Mac validation-data generation failed.', ERROR_KINDS.INTERNAL);
  } finally {
    if (context) {
      try { await context.destroy(); }
      catch (cleanupError) {
        if (!primaryError) {
          if (cleanupError instanceof RuntimeError) throw cleanupError;
          throw validationError('NAC_VALIDATION_FAILED',
            'Mac validation-data cleanup failed.', ERROR_KINDS.INTERNAL);
        }
      }
    }
  }
};

function createValidationDataGenerator(options) {
  return new ValidationDataGenerator(options);
}

async function generateValidationData(options) {
  requireDependencies(options);
  return createValidationDataGenerator(options).generate(options.hardware);
}

module.exports = {
  CERTIFICATE_BAG_KEY: CERTIFICATE_BAG_KEY,
  INITIALIZATION_BAG_KEY: INITIALIZATION_BAG_KEY,
  MAX_PLIST_DATA_BYTES: MAX_PLIST_DATA_BYTES,
  MAX_PLIST_RESPONSE_BYTES: MAX_PLIST_RESPONSE_BYTES,
  ValidationDataGenerator: ValidationDataGenerator,
  buildCertificateRequest: buildCertificateRequest,
  buildInitializationRequest: buildInitializationRequest,
  createValidationDataGenerator: createValidationDataGenerator,
  generateValidationData: generateValidationData,
};
