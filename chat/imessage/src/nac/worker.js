'use strict';
var bytes = require('../runtime/bytes');
var WasmHostX86Provider = require('../runtime/wasm-x86-provider').WasmHostX86Provider;
var contextModule = require('./validation-context');
var hardware = require('./hardware-environment');

function encode(value) {
  return JSON.parse(JSON.stringify(value, function (_, item) {
    return item instanceof Uint8Array ? { $bytes: bytes.bytesToBase64(item) } : item;
  }));
}
function decode(value) {
  return JSON.parse(JSON.stringify(value), function (_, item) {
    return item && typeof item === 'object' && typeof item.$bytes === 'string'
      ? bytes.base64ToBytes(item.$bytes) : item;
  });
}
function install(globalObject, randomWord) {
  var context = null;
  var provider = new WasmHostX86Provider({
    randomBytes: function (size) { return globalObject.crypto.getRandomValues(new Uint8Array(size)); },
  });
  function destroy() {
    try { if (context) context.destroy(); }
    finally { context = null; provider.close(); }
  }
  globalObject.onmessage = function (event) {
    var request = event.data, result;
    try {
      var payload = decode(request.payload);
      if (request.method === 'init') {
        if (context) throw new Error('Already initialized');
        context = contextModule.createValidationContext({
          machineProvider: provider,
          image: payload.image,
          certificateChain: payload.certificate,
          hardwareEnvironment: hardware.createHardwareEnvironment(payload.hardware),
          randomWord: randomWord || function () { return globalObject.crypto.getRandomValues(new Uint32Array(1))[0]; },
        });
        result = context.sessionInfoRequest;
      } else if (request.method === 'sign') {
        if (!context) throw new Error('Not initialized');
        context.establish(payload.sessionInfo);
        result = context.sign();
      } else if (request.method === 'destroy') {
        destroy(); result = true;
      } else throw new Error('Unknown operation');
      globalObject.postMessage({id:request.id,ok:true,result:encode(result)});
      if (result instanceof Uint8Array && request.method !== 'init') result.fill(0);
    } catch (error) {
      destroy();
      globalObject.postMessage({id:request.id,ok:false,code:error.code || 'NAC_WORKER_FAILED'});
    }
  };
}
module.exports = { install: install, encode: encode, decode: decode };
