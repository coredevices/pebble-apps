'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const bytes = require('../../src/runtime/bytes');
const binaryPlist = require('../../src/codecs/binary-plist');
const xmlPlist = require('../../src/codecs/xml-plist');
const foundation = require('../../src/nac/emulated-foundation');
const image = require('../../src/nac/image');
const macho = require('../../src/nac/macho-imports');
const validationContext = require('../../src/nac/validation-context');
const validationData = require('../../src/nac/validation-data');

function u32(target, offset, value) { target.set(bytes.uint32LE(value), offset); }
function u64(target, offset, value) {
  let remaining = BigInt(value);
  for (let index = 0; index < 8; index += 1) {
    target[offset + index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
}
function wordBytes(value) { const result = new Uint8Array(8); u64(result, 0, value); return result; }

function importedImage() {
  const names = foundation.HOOK_SYMBOLS.concat(['_unrelated_image_import']);
  const result = new Uint8Array(8192);
  const symbolsOffset = 512;
  const stringsOffset = 1280;
  const indirectOffset = 2560;
  const pointersOffset = 3072;
  u32(result, 0, 0xfeedfacf);
  u32(result, 4, 0x01000007);
  u32(result, 16, 3);
  u32(result, 20, 256);
  let command = 32;
  u32(result, command, macho.LC_SEGMENT_64);
  u32(result, command + 4, 152);
  u64(result, command + 40, 0);
  u64(result, command + 48, result.length);
  u32(result, command + 64, 1);
  const section = command + 72;
  u64(result, section + 40, names.length * 8);
  u32(result, section + 48, pointersOffset);
  u32(result, section + 64, macho.S_NON_LAZY_SYMBOL_POINTERS);
  u32(result, section + 68, 0);
  command += 152;
  u32(result, command, macho.LC_SYMTAB);
  u32(result, command + 4, 24);
  u32(result, command + 8, symbolsOffset);
  u32(result, command + 12, names.length);
  u32(result, command + 16, stringsOffset);
  let stringCursor = 1;
  names.forEach((name, index) => {
    u32(result, symbolsOffset + index * 16, stringCursor);
    const encoded = bytes.utf8ToBytes(name + '\0');
    result.set(encoded, stringsOffset + stringCursor);
    stringCursor += encoded.length;
    u32(result, indirectOffset + index * 4, index);
  });
  u32(result, command + 20, stringCursor);
  command += 24;
  u32(result, command, macho.LC_DYSYMTAB);
  u32(result, command + 4, 80);
  u32(result, command + 56, indirectOffset);
  u32(result, command + 60, names.length);
  return result;
}

function fixtureHardware() {
  return {
    productName: 'Mac17,3', ioMacAddress: Uint8Array.from([1, 2, 3, 4, 5, 6]),
    platformSerialNumber: 'SERIAL123', platformUuid: '3BA98E0D-BAA9-5F97-BDFD-32F127F62874',
    rootDiskUuid: 'B73F8357-5211-4526-9232-ADB6AC714D82', boardId: 'Mac-24000000',
    platformSerialNumberEnc: new Uint8Array(17).fill(1), platformUuidEnc: new Uint8Array(17).fill(2),
    rootDiskUuidEnc: new Uint8Array(17).fill(3), rom: Uint8Array.from([7, 8, 9, 10, 11, 12]),
    romEnc: new Uint8Array(17).fill(4), mlb: 'MLB123456789', mlbEnc: new Uint8Array(17).fill(5),
  };
}

function ScriptedMachine(plan) {
  this.memory = new Map();
  this.registers = Object.assign({ rax: 0n, rsp: 0n, rbp: 0n }, plan.registers);
  this.nextToken = 1;
  this.destroyCount = 0;
  this.established = false;
  plan.writes.forEach(write => this.write(write.address, write.data));
  plan.fills.forEach(fill => this.write(fill.address, new Uint8Array(fill.length).fill(fill.byte)));
}
ScriptedMachine.prototype.write = function (address, data) {
  let cursor = BigInt(address);
  data.forEach(value => { this.memory.set(cursor, value); cursor += 1n; });
};
ScriptedMachine.prototype.read = function (address, length) {
  const result = new Uint8Array(length);
  let cursor = BigInt(address);
  for (let index = 0; index < length; index += 1) {
    result[index] = this.memory.get(cursor) || 0;
    cursor += 1n;
  }
  return result;
};
ScriptedMachine.prototype.apply = function (effects) {
  effects.forEach(effect => {
    if (effect.kind === 'write') this.write(effect.address, effect.data);
    else if (effect.kind === 'fill') this.write(effect.address, new Uint8Array(effect.length).fill(effect.byte));
    else if (effect.kind === 'set-registers') Object.assign(this.registers, effect.values);
    else throw new Error('unexpected fake effect');
  });
};
ScriptedMachine.prototype.complete = function () {
  this.registers.rax = 0n;
  this.registers.rsp = BigInt(validationContext.STACK_BASE + validationContext.STACK_SIZE);
  return {
    kind: 'until', address: BigInt(validationContext.STOP_ADDRESS), pauseToken: this.nextToken++,
    registers: Object.assign({}, this.registers),
  };
};
ScriptedMachine.prototype.start = function (begin, until, effects) {
  this.apply(effects);
  assert.equal(until, BigInt(validationContext.STOP_ADDRESS));
  if (begin === BigInt(validationContext.NAC_INIT_ADDRESS)) {
    const output = Uint8Array.from([0x31, 0x32, 0x33]);
    const outputAddress = 0x4e0000n;
    this.write(outputAddress, output);
    this.write(this.registers.rdx, wordBytes(0x123456n));
    this.write(this.registers.rcx, wordBytes(outputAddress));
    this.write(this.registers.r8, wordBytes(BigInt(output.length)));
    return this.complete();
  }
  if (begin === BigInt(validationContext.NAC_ESTABLISH_ADDRESS)) {
    assert.deepEqual(this.read(this.registers.rsi, Number(this.registers.rdx)), Uint8Array.from([7, 8, 9]));
    this.established = true;
    return this.complete();
  }
  if (begin === BigInt(validationContext.NAC_SIGN_ADDRESS)) {
    assert.equal(this.established, true);
    const output = Uint8Array.from([4, 3, 2, 1]);
    const outputAddress = 0x4f0000n;
    this.write(outputAddress, output);
    this.write(this.registers.rcx, wordBytes(outputAddress));
    this.write(this.registers.r8, wordBytes(BigInt(output.length)));
    return this.complete();
  }
  throw new Error('unexpected fake entrypoint');
};
ScriptedMachine.prototype.resume = function () { throw new Error('unexpected trap'); };
ScriptedMachine.prototype.inspect = function (pauseToken, reads, registers) {
  return {
    pauseToken,
    reads: reads.map(read => ({ id: read.id, data: this.read(read.address, read.length) })),
    registers: Object.fromEntries(registers.map(name => [name, this.registers[name]])),
  };
};
ScriptedMachine.prototype.destroy = function () { this.destroyCount += 1; };

function fixtures(overrides) {
  const binary = importedImage();
  const requests = [];
  const machines = [];
  const endpoints = {
    validationCertificateEndpoint: 'https://identity.ess.apple.com/validation/cert',
    validationInitializationEndpoint: 'https://identity.ess.apple.com/validation/initialize',
  };
  let sha256 = 0;
  const values = {
    effects: { http: { request: async function (request) {
      requests.push(request);
      if (request.url === image.PINNED_IMAGE_URL) return { status: 200, headers: [], body: binary };
      if (request.url === endpoints.validationCertificateEndpoint) return {
        status: 200, headers: [], body: xmlPlist.encodeXmlPlist({ cert: Uint8Array.from([1, 2, 3]) }),
      };
      if (request.url === endpoints.validationInitializationEndpoint) {
        assert.deepEqual(xmlPlist.decodeXmlPlist(request.body), {
          'session-info-request': Uint8Array.from([0x31, 0x32, 0x33]),
        });
        return {
          status: 200, headers: [],
          body: binaryPlist.encodeBinaryPlist({ 'session-info': Uint8Array.from([7, 8, 9]) }),
        };
      }
      throw new Error('unexpected URL');
    } } },
    crypto: { digest: function (algorithm) {
      if (algorithm === 'sha1') return bytes.hexToBytes(image.PINNED_IMAGE_SHA1);
      sha256 += 1;
      return bytes.hexToBytes(sha256 % 2 === 1
        ? image.PINNED_IMAGE_SHA256 : image.PINNED_X86_64_SHA256);
    } },
    machineProvider: { create: function (plan) {
      const machine = new ScriptedMachine(plan); machines.push(machine); return machine;
    } },
    randomWord: () => 0x10203040,
    endpoints,
  };
  return { options: Object.assign(values, overrides || {}), requests, machines };
}

test('Mac validation-data flow caches only the verified image and recreates every Apple/NAC exchange', async function () {
  const { options, requests, machines } = fixtures();
  const generator = validationData.createValidationDataGenerator(options);
  assert.deepEqual(await generator.generate(fixtureHardware()), Uint8Array.from([4, 3, 2, 1]));
  assert.deepEqual(await generator.generate(fixtureHardware()), Uint8Array.from([4, 3, 2, 1]));
  assert.deepEqual(requests.map(request => request.url), [
    image.PINNED_IMAGE_URL,
    options.endpoints.validationCertificateEndpoint,
    options.endpoints.validationInitializationEndpoint,
    options.endpoints.validationCertificateEndpoint,
    options.endpoints.validationInitializationEndpoint,
  ]);
  assert.equal(requests[1].method, 'GET');
  assert.equal(requests[2].method, 'POST');
  assert.equal(requests[1].bagKey, 'id-validation-cert');
  assert.equal(requests[2].bagKey, 'id-initialize-validation');
  assert.equal(requests[1].maxResponseBytes, 2 * 1024 * 1024);
  assert.equal(machines.length, 2);
  assert.deepEqual(machines.map(machine => machine.destroyCount), [1, 1]);
});

test('Mac validation-data rejects untrusted endpoints and destroys an initialized context on network failure', async function () {
  const untrusted = fixtures({ endpoints: {
    validationCertificateEndpoint: 'https://example.test/cert',
    validationInitializationEndpoint: 'https://identity.apple.com/initialize',
  } });
  assert.throws(() => validationData.createValidationDataGenerator(untrusted.options), /untrusted endpoint/);
  assert.equal(untrusted.requests.length, 0);

  const failed = fixtures();
  const original = failed.options.effects.http.request;
  failed.options.effects = { http: { request: async function (request) {
    if (request.url === failed.options.endpoints.validationInitializationEndpoint) {
      return { status: 503, headers: [], body: bytes.utf8ToBytes('private server detail') };
    }
    return original(request);
  } } };
  await assert.rejects(validationData.generateValidationData(Object.assign({
    hardware: fixtureHardware(),
  }, failed.options)), error => (
    error.code === 'NAC_VALIDATION_NETWORK_ERROR'
      && error.details.httpStatus === 503
      && !error.message.includes('private')
  ));
  assert.equal(failed.machines.length, 1);
  assert.equal(failed.machines[0].destroyCount, 1);
});

test('Mac validation-data request builders enforce Apple endpoints and the RustPush XML wire format', function () {
  assert.throws(() => validationData.buildCertificateRequest('http://identity.apple.com/cert'), /untrusted endpoint/);
  assert.throws(() => validationData.buildInitializationRequest(
    'https://identity.apple.com/initialize', new Uint8Array(0)
  ), /session-info request/);
  const request = validationData.buildInitializationRequest(
    'https://identity.apple.com/initialize', Uint8Array.from([9, 8])
  );
  assert.equal(validationData.buildCertificateRequest('https://static.ess.apple.com/cert').trustAnchors.length, 2);
  assert.equal(request.trustAnchors.length, 2);
  assert.deepEqual(xmlPlist.decodeXmlPlist(request.body), {
    'session-info-request': Uint8Array.from([9, 8]),
  });
});
