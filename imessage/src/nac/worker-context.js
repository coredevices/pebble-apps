'use strict';
var wire = require('./worker');
var source = require('../runtime/generated/nac-worker-source');

async function createWorkerContext(provider, options) {
  var worker = provider.open(source);
  try {
    var request = wire.decode(await worker.request('init', wire.encode({
      image: options.image, certificate: options.certificate, hardware: options.hardware,
    })));
    return {
      sessionInfoRequest: request,
      establish: function (sessionInfo) { this.sessionInfo = sessionInfo; },
      sign: async function () { return wire.decode(await worker.request('sign', wire.encode({sessionInfo:this.sessionInfo}))); },
      destroy: async function () {
        try { await worker.request('destroy', {}); }
        finally { worker.close(); }
      },
    };
  } catch (error) { worker.close(); throw error; }
}
module.exports = { createWorkerContext: createWorkerContext };
