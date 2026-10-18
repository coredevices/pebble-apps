'use strict';

var bytes = require('../../src/runtime/bytes');
var CryptoCompositions = require('../../src/crypto/compositions').CryptoCompositions;
var NativeHostCryptoProvider = require('../../src/runtime/host-crypto-provider').NativeHostCryptoProvider;
var WasmHostX86Provider = require('../../src/runtime/wasm-x86-provider').WasmHostX86Provider;
var hardwareModule = require('../../src/nac/hardware-environment');
var imageModule = require('../../src/nac/image');
var validationContextModule = require('../../src/nac/validation-context');
var vectorModule = require('./vector');

function decodeCanonical(value) {
  var decoded = bytes.base64ToBytes(value);
  if (bytes.bytesToBase64(decoded) !== value) {
    var error = new Error('Noncanonical parity bytes');
    error.code = 'NAC_PARITY_INPUT_INVALID';
    throw error;
  }
  return decoded;
}

function digestHex(crypto, value) {
  return bytes.bytesToHex(crypto.digest('sha256', value));
}

function parityMismatch() {
  var error = new Error('Android NAC output differed from the offline oracle');
  error.code = 'NAC_PARITY_MISMATCH';
  throw error;
}

function verifyDescriptor(crypto, value, descriptor) {
  if (value.length !== descriptor.length
      || digestHex(crypto, value) !== descriptor.sha256
      || !bytes.bytesEqual(value, decodeCanonical(descriptor.base64))) parityMismatch();
}

function productionHardware(value) {
  return {
    productName: value.productName,
    ioMacAddress: Uint8Array.from(value.ioMacAddress),
    platformSerialNumber: value.platformSerialNumber,
    platformUuid: value.platformUuid,
    rootDiskUuid: value.rootDiskUuid,
    boardId: value.boardId,
    platformSerialNumberEnc: Uint8Array.from(value.platformSerialNumberEnc),
    platformUuidEnc: Uint8Array.from(value.platformUuidEnc),
    rootDiskUuidEnc: Uint8Array.from(value.rootDiskUuidEnc),
    rom: Uint8Array.from(value.rom),
    romEnc: Uint8Array.from(value.romEnc),
    mlb: value.mlb,
    mlbEnc: Uint8Array.from(value.mlbEnc),
  };
}

function run(rawInput, globalObject) {
  var input;
  try { input = JSON.parse(rawInput); }
  catch (_) {
    var malformed = new Error('Parity input is not JSON');
    malformed.code = 'NAC_PARITY_INPUT_INVALID';
    throw malformed;
  }
  vectorModule.validateLocalInput(input);

  var crypto = new CryptoCompositions(new NativeHostCryptoProvider(globalObject._HostCrypto));
  var machineProvider = new WasmHostX86Provider({ randomBytes: function (size) { return crypto.random(size); } });
  var fullImage = decodeCanonical(input.imageBase64);
  var thinImage = imageModule.verifyPinnedImage(fullImage, crypto);
  var vector = input.vector;
  var certificate = decodeCanonical(vector.certificateChainBase64);
  var sessionInfo = decodeCanonical(vector.sessionInfoBase64);
  var expectedRequest = decodeCanonical(vector.expected.sessionInfoRequest.base64);
  var expectedValidation = decodeCanonical(vector.expected.validationData.base64);

  var randomIndex = 0;
  function randomWord() {
    if (randomIndex >= vector.arc4randomWords.length) {
      var exhausted = new Error('Deterministic random input was exhausted');
      exhausted.code = 'NAC_PARITY_RANDOM_MISMATCH';
      throw exhausted;
    }
    var word = vector.arc4randomWords[randomIndex];
    randomIndex += 1;
    return word;
  }

  var context = null;
  var validationData = null;
  try {
    verifyDescriptor(crypto, expectedRequest, vector.expected.sessionInfoRequest);
    verifyDescriptor(crypto, expectedValidation, vector.expected.validationData);
    context = validationContextModule.createValidationContext({
      machineProvider: machineProvider,
      image: thinImage,
      certificateChain: certificate,
      hardwareEnvironment: hardwareModule.createHardwareEnvironment(productionHardware(vector.hardware)),
      randomWord: randomWord,
    });
    verifyDescriptor(crypto, context.sessionInfoRequest, vector.expected.sessionInfoRequest);
    context.establish(sessionInfo);
    validationData = context.sign();
    verifyDescriptor(crypto, validationData, vector.expected.validationData);
    if (randomIndex !== vector.arc4randomWords.length) {
      var unused = new Error('Deterministic random input had unused words');
      unused.code = 'NAC_PARITY_RANDOM_MISMATCH';
      throw unused;
    }
    return {
      ok: true,
      id: vector.id,
      randomWordsConsumed: randomIndex,
      sessionInfoRequest: {
        length: context.sessionInfoRequest.length,
        sha256: digestHex(crypto, context.sessionInfoRequest),
      },
      validationData: {
        length: validationData.length,
        sha256: digestHex(crypto, validationData),
      },
    };
  } finally {
    if (context) {
      try { context.destroy(); } catch (_) { /* The original parity result remains authoritative. */ }
      context.sessionInfoRequest.fill(0);
    }
    fullImage.fill(0);
    thinImage.fill(0);
    certificate.fill(0);
    sessionInfo.fill(0);
    expectedRequest.fill(0);
    expectedValidation.fill(0);
    if (validationData) validationData.fill(0);
  }
}

function safeFailure(error) {
  var code = error && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code : 'NAC_PARITY_FAILED';
  return { ok: false, code: code };
}

globalThis.__runNacAndroidParity = function () {
  var result;
  try { result = run(globalThis._NacParityInput.read(), globalThis); }
  catch (error) { result = safeFailure(error); }
  globalThis._NacParityResult.complete(JSON.stringify(result));
};

module.exports = { run: run };
