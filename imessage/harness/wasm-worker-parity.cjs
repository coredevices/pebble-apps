'use strict';
// Private inputs come from android-nac-parity/stage.mjs; never commit them.
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const bytes = require('../src/runtime/bytes');
const image = require('../src/nac/image');
const {validateLocalInput} = require('./android-nac-parity/vector');
const {HostJsWorker} = require('../src/runtime/host-js-worker');
const {createWorkerContext} = require('../src/nac/worker-context');

(async () => {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  validateLocalInput(input);
  const vector = input.vector, globalObject = {}, workers = new Map();
  let randomIndex = 0, next = 0;
  const timer = {after: (ms, fn) => setTimeout(fn, ms), cancel: clearTimeout};
  const native = {
    open(source) {
      const id = ++next;
      const context = vm.createContext({
        crypto: {getRandomValues(array) {
          if (array.constructor.name === 'Uint32Array' && array.length === 1) {
            assert.ok(randomIndex < vector.arc4randomWords.length);
            array[0] = vector.arc4randomWords[randomIndex++];
            return array;
          }
          return crypto.randomFillSync(array);
        }},
        postMessage(value) { globalObject.__hostJsWorkerDispatch(id, JSON.stringify(value)); },
      });
      vm.runInContext(source, context);
      workers.set(id, context);
      return id;
    },
    send(id, raw) {
      const context = workers.get(id);
      context.input = raw;
      vm.runInContext('onmessage({data:JSON.parse(input)});input=null;', context);
    },
    close(id) { workers.delete(id); },
  };
  const hardware = {};
  for (const [key, value] of Object.entries(vector.hardware)) {
    hardware[key] = Array.isArray(value) ? Uint8Array.from(value) : value;
  }
  const start = Date.now();
  const context = await createWorkerContext(new HostJsWorker(native, timer, globalObject), {
    image: image.verifyPinnedImage(bytes.base64ToBytes(input.imageBase64), {
      digest: (algorithm, value) => new Uint8Array(crypto.createHash(algorithm).update(value).digest()),
    }),
    certificate: bytes.base64ToBytes(vector.certificateChainBase64),
    hardware,
  });
  try {
    assert.deepEqual(context.sessionInfoRequest, bytes.base64ToBytes(vector.expected.sessionInfoRequest.base64));
    await context.establish(bytes.base64ToBytes(vector.sessionInfoBase64));
    const result = await context.sign();
    assert.deepEqual(result, bytes.base64ToBytes(vector.expected.validationData.base64));
    result.fill(0);
    assert.equal(randomIndex, vector.arc4randomWords.length);
  } finally { await context.destroy(); }
  assert.equal(workers.size, 0);
  console.log(JSON.stringify({ok:true,ms:Date.now()-start,randomWordsConsumed:randomIndex,workersClosed:true}));
})().catch(error => {
  console.error(JSON.stringify({ok:false,code:error.code || 'WORKER_PARITY_FAILED'}));
  process.exitCode = 1;
});
