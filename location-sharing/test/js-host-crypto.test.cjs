const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
// The plugin host has no WebCrypto; any randomness not routed through _HostCrypto must fail loudly.
Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
const { JsHostCrypto, KEY_PREFIX } = require('../src/runtime/js-host-crypto');

const hostRandom = {
  calls: 0,
  request(json) {
    const request = JSON.parse(json);
    assert.equal(request.operation, 'random');
    this.calls += 1;
    // Same bounds as the PR 291 host's _HostCrypto.
    if (!(request.length >= 1 && request.length <= 65536)) {
      return JSON.stringify({ ok: false, error: 'Invalid random length' });
    }
    return JSON.stringify({ ok: true, data: nodeCrypto.randomBytes(request.length).toString('base64') });
  },
};

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  };
}

function provider(storage = memoryStorage()) {
  const crypto = new JsHostCrypto(hostRandom, storage);
  return {
    storage,
    raw: request => JSON.parse(crypto.request(JSON.stringify(request))),
    call(request) {
      const response = this.raw(request);
      assert.equal(response.ok, true, JSON.stringify(response));
      return response;
    },
    bytes(request) { return Buffer.from(this.call(request).data, 'base64'); },
  };
}

const b64 = value => Buffer.from(value).toString('base64');
const spkiOf = key => key.export({ type: 'spki', format: 'der' });
const HASHES = { 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };
const data = nodeCrypto.randomBytes(1000);

test('random is served by the host random operation', () => {
  const before = hostRandom.calls;
  assert.equal(provider().bytes({ operation: 'random', length: 33 }).length, 33);
  assert.equal(hostRandom.calls, before + 1);
});

test('random handles zero and lengths above the host limit', () => {
  const before = hostRandom.calls;
  assert.equal(provider().bytes({ operation: 'random', length: 0 }).length, 0);
  assert.equal(hostRandom.calls, before);
  assert.equal(provider().bytes({ operation: 'random', length: 200000 }).length, 200000);
  assert.equal(hostRandom.calls, before + 4);
});

test('digest, hmac, pbkdf2 and hkdf match node', () => {
  const p = provider();
  const key = nodeCrypto.randomBytes(20);
  const salt = nodeCrypto.randomBytes(16);
  for (const [name, node] of Object.entries(HASHES)) {
    assert.deepEqual(p.bytes({ operation: 'digest', algorithm: name, data: b64(data) }),
      nodeCrypto.createHash(node).update(data).digest());
    assert.deepEqual(p.bytes({ operation: 'hmac', algorithm: 'HMAC-' + name, key: b64(key), data: b64(data) }),
      nodeCrypto.createHmac(node, key).update(data).digest());
    assert.deepEqual(p.bytes({ operation: 'hmac', algorithm: 'HMAC-' + name, key: '', data: b64(data) }),
      nodeCrypto.createHmac(node, Buffer.alloc(0)).update(data).digest());
    assert.deepEqual(p.bytes({
      operation: 'pbkdf2', algorithm: 'HMAC-' + name, password: b64(key), salt: b64(salt), iterations: 1000, length: 70,
    }), nodeCrypto.pbkdf2Sync(key, salt, 1000, 70, node));
    for (const hkdfSalt of [salt, Buffer.alloc(0)]) {
      assert.deepEqual(p.bytes({
        operation: 'hkdf', algorithm: 'HMAC-' + name, key: b64(key), salt: b64(hkdfSalt), info: b64('info'), length: 90,
      }), Buffer.from(nodeCrypto.hkdfSync(node, key, hkdfSalt, 'info', 90)));
    }
  }
  assert.equal(p.raw({ operation: 'digest', algorithm: 'MD5', data: '' }).code, 'UNSUPPORTED_ALGORITHM');
  assert.equal(p.raw({ operation: 'hkdf', algorithm: 'HMAC-SHA-1', key: '', salt: '', info: '', length: 20 * 256 }).code,
    'INVALID_REQUEST');
});

test('streaming digest matches one-shot digest and handles are tracked', () => {
  const p = provider();
  const { handle } = p.call({ operation: 'digest-open', algorithm: 'SHA-256' });
  for (let offset = 0; offset < data.length; offset += 300) {
    p.call({ operation: 'digest-update', handle, data: b64(data.subarray(offset, offset + 300)) });
  }
  assert.deepEqual(p.bytes({ operation: 'digest-finish', handle }), nodeCrypto.createHash('sha256').update(data).digest());
  assert.equal(p.raw({ operation: 'digest-finish', handle }).code, 'SESSION_NOT_FOUND');
  const aborted = p.call({ operation: 'digest-open', algorithm: 'SHA-1' }).handle;
  assert.equal(p.call({ operation: 'digest-abort', handle: aborted }).deleted, true);
  assert.equal(p.call({ operation: 'digest-abort', handle: aborted }).deleted, false);
});

test('AES-CBC (both paddings) and AES-CTR match node', () => {
  const p = provider();
  for (const size of [16, 24, 32]) {
    const key = nodeCrypto.randomBytes(size);
    const iv = nodeCrypto.randomBytes(16);
    const bits = size * 8;
    const padded = nodeCrypto.createCipheriv(`aes-${bits}-cbc`, key, iv);
    const expectedPadded = Buffer.concat([padded.update(data), padded.final()]);
    const request = { key: b64(key), iv: b64(iv) };
    assert.deepEqual(p.bytes({ ...request, operation: 'aes-cbc-encrypt', padding: 'PKCS7', data: b64(data) }), expectedPadded);
    assert.deepEqual(p.bytes({ ...request, operation: 'aes-cbc-decrypt', padding: 'PKCS7', data: b64(expectedPadded) }), data);

    const blocks = data.subarray(0, 992);
    const unpadded = nodeCrypto.createCipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(false);
    const expectedUnpadded = Buffer.concat([unpadded.update(blocks), unpadded.final()]);
    assert.deepEqual(p.bytes({ ...request, operation: 'aes-cbc-encrypt', padding: 'NONE', data: b64(blocks) }), expectedUnpadded);
    assert.deepEqual(p.bytes({ ...request, operation: 'aes-cbc-decrypt', data: b64(expectedUnpadded) }), blocks);
    assert.equal(p.raw({ ...request, operation: 'aes-cbc-encrypt', data: b64(data) }).code, 'INVALID_REQUEST');

    const counter = Buffer.alloc(16, 0xff);
    for (const ctrIv of [iv, counter]) {
      assert.deepEqual(p.bytes({ key: b64(key), iv: b64(ctrIv), operation: 'aes-ctr', data: b64(data) }),
        nodeCrypto.createCipheriv(`aes-${bits}-ctr`, key, ctrIv).update(data));
    }
  }
});

test('ECDSA P-256 signatures interoperate with node in both directions', () => {
  const p = provider();
  const generated = p.call({ operation: 'generate-key', keyType: 'EC', curve: 'secp256r1', persistent: false });
  const spki = p.bytes({ operation: 'export-public-key', handle: generated.handle });
  assert.equal(generated.publicKey, b64(spki));
  const publicKey = nodeCrypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.equal(publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  const node = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  for (const [name, hash] of Object.entries(HASHES)) {
    const algorithm = name.replace('-', '') + 'withECDSA';
    const signature = p.bytes({ operation: 'sign', handle: generated.handle, algorithm, data: b64(data) });
    assert.ok(nodeCrypto.verify(hash, data, publicKey, signature), algorithm);
    const nodeSignature = nodeCrypto.sign(hash, data, node.privateKey);
    const request = { operation: 'verify', algorithm, peerPublicKey: b64(spkiOf(node.publicKey)), data: b64(data) };
    assert.equal(p.call({ ...request, signature: b64(nodeSignature) }).verified, true, algorithm);
    assert.equal(p.call({ ...request, data: b64('other'), signature: b64(nodeSignature) }).verified, false);
    assert.equal(p.call({ ...request, signature: b64('garbage') }).verified, false);
  }
  assert.equal(p.raw({ operation: 'sign', handle: generated.handle, algorithm: 'SHA256withRSA', data: '' }).code,
    'UNSUPPORTED_ALGORITHM');
});

test('ECDH shared secret matches node', () => {
  const p = provider();
  const { handle } = p.call({ operation: 'generate-key', keyType: 'EC', curve: 'secp256r1' });
  const ours = nodeCrypto.createPublicKey({ key: p.bytes({ operation: 'export-public-key', handle }), format: 'der', type: 'spki' });
  const node = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const secret = p.bytes({ operation: 'derive', handle, algorithm: 'ECDH', peerPublicKey: b64(spkiOf(node.publicKey)) });
  assert.equal(secret.length, 32);
  assert.deepEqual(secret, nodeCrypto.diffieHellman({ privateKey: node.privateKey, publicKey: ours }));
  const rsa = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.equal(p.raw({ operation: 'derive', handle, algorithm: 'ECDH', peerPublicKey: b64(spkiOf(rsa.publicKey)) }).code,
    'INVALID_REQUEST');
});

test('generated RSA keys sign and are verified by node', () => {
  const p = provider();
  for (const keySize of [1024, 1280, 2048]) {
    const generated = p.call({ operation: 'generate-key', keyType: 'RSA', keySize, persistent: false });
    const publicKey = nodeCrypto.createPublicKey({ key: Buffer.from(generated.publicKey, 'base64'), format: 'der', type: 'spki' });
    assert.equal(publicKey.asymmetricKeyDetails.modulusLength, keySize);
    assert.equal(publicKey.asymmetricKeyDetails.publicExponent, 65537n);
    for (const [name, hash] of Object.entries(HASHES)) {
      const signature = p.bytes({ operation: 'sign', handle: generated.handle, algorithm: name.replace('-', '') + 'withRSA', data: b64(data) });
      assert.equal(signature.length, keySize / 8);
      assert.ok(nodeCrypto.verify(hash, data, publicKey, signature), `${keySize} ${name}`);
    }
  }
  assert.equal(p.raw({ operation: 'generate-key', keyType: 'RSA', keySize: 1000 }).code, 'INVALID_REQUEST');
});

test('RSA verify accepts node signatures and rejects tampering', () => {
  const p = provider();
  const node = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const peerPublicKey = b64(spkiOf(node.publicKey));
  for (const [name, hash] of Object.entries(HASHES)) {
    const signature = nodeCrypto.sign(hash, data, node.privateKey);
    const request = { operation: 'verify', algorithm: name.replace('-', '') + 'withRSA', peerPublicKey, data: b64(data) };
    assert.equal(p.call({ ...request, signature: b64(signature) }).verified, true, name);
    signature[10] ^= 1;
    assert.equal(p.call({ ...request, signature: b64(signature) }).verified, false, name);
  }
});

test('RSA-OAEP ciphertexts decrypt with node', () => {
  const p = provider();
  const node = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 1280 });
  const message = nodeCrypto.randomBytes(60);
  for (const [algorithm, oaepHash] of [['RSA-OAEP-SHA1', 'sha1'], ['RSA-OAEP-SHA256', 'sha256']]) {
    const ciphertext = p.bytes({ operation: 'rsa-oaep-encrypt', algorithm, peerPublicKey: b64(spkiOf(node.publicKey)), data: b64(message) });
    assert.equal(ciphertext.length, 160);
    assert.deepEqual(nodeCrypto.privateDecrypt({
      key: node.privateKey, padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash,
    }, ciphertext), message);
  }
});

test('import-private-key accepts node PKCS#8 + SPKI and rejects mismatched pairs', () => {
  const p = provider();
  const rsa = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  for (const [keyType, pair, algorithm, hash] of [['RSA', rsa, 'SHA1withRSA', 'sha1'], ['EC', ec, 'SHA256withECDSA', 'sha256']]) {
    const privateKey = b64(pair.privateKey.export({ type: 'pkcs8', format: 'der' }));
    const publicKey = b64(spkiOf(pair.publicKey));
    const { handle } = p.call({ operation: 'import-private-key', keyType, privateKey, publicKey, persistent: false });
    assert.equal(p.call({ operation: 'export-public-key', handle }).data, publicKey);
    const signature = p.bytes({ operation: 'sign', handle, algorithm, data: b64(data) });
    assert.ok(nodeCrypto.verify(hash, data, pair.publicKey, signature), keyType);
    assert.equal(p.call({ operation: 'delete-key', handle }).deleted, true);
    assert.equal(p.raw({ operation: 'sign', handle, algorithm, data: '' }).code, 'KEY_NOT_FOUND');
  }
  const otherRsa = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(p.raw({
    operation: 'import-private-key', keyType: 'RSA',
    privateKey: b64(rsa.privateKey.export({ type: 'pkcs8', format: 'der' })), publicKey: b64(spkiOf(otherRsa.publicKey)),
  }).message, 'Imported private and public keys do not match');
  assert.equal(p.raw({
    operation: 'import-private-key', keyType: 'EC',
    privateKey: b64(rsa.privateKey.export({ type: 'pkcs8', format: 'der' })), publicKey: b64(spkiOf(ec.publicKey)),
  }).code, 'INVALID_REQUEST');
});

test('persistent keys survive a new provider over the same storage; session keys do not', () => {
  const storage = memoryStorage();
  const first = provider(storage);
  const kept = first.call({ operation: 'generate-key', keyType: 'EC', curve: 'secp256r1' }).handle;
  const imported = first.call({
    operation: 'import-private-key', keyType: 'RSA',
    ...(() => {
      const pair = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
      return { privateKey: b64(pair.privateKey.export({ type: 'pkcs8', format: 'der' })), publicKey: b64(spkiOf(pair.publicKey)) };
    })(),
  }).handle;
  const session = first.call({ operation: 'generate-key', keyType: 'EC', curve: 'secp256r1', persistent: false }).handle;
  assert.deepEqual([...storage.map.keys()].sort(), [KEY_PREFIX + kept, KEY_PREFIX + imported].sort());

  const second = provider(storage);
  const publicKey = nodeCrypto.createPublicKey({ key: second.bytes({ operation: 'export-public-key', handle: kept }), format: 'der', type: 'spki' });
  const signature = second.bytes({ operation: 'sign', handle: kept, algorithm: 'SHA256withECDSA', data: b64(data) });
  assert.ok(nodeCrypto.verify('sha256', data, publicKey, signature));
  second.call({ operation: 'sign', handle: imported, algorithm: 'SHA1withRSA', data: b64(data) });
  assert.equal(second.raw({ operation: 'export-public-key', handle: session }).code, 'KEY_NOT_FOUND');
  assert.equal(second.call({ operation: 'delete-key', handle: kept }).deleted, true);
  assert.equal(provider(storage).raw({ operation: 'export-public-key', handle: kept }).code, 'KEY_NOT_FOUND');
});

test('malformed requests report the Kotlin bridge error shape', () => {
  const p = provider();
  assert.deepEqual(p.raw({ operation: 'nope' }), { ok: false, code: 'INVALID_REQUEST', message: 'Unknown host crypto operation' });
  assert.equal(p.raw({ operation: 'digest', algorithm: 'SHA-1', data: 'AA' }).code, 'INVALID_REQUEST');
  assert.equal(p.raw({ operation: 'digest', algorithm: 'SHA-1', data: '', extra: 1 }).code, 'INVALID_REQUEST');
  assert.equal(p.raw({ operation: 'sign', handle: 'x', algorithm: 'SHA1withRSA', data: '' }).message, 'Key handle is malformed');
  assert.equal(p.raw({ operation: 'aes-cbc-decrypt', key: b64(Buffer.alloc(16)), iv: b64(Buffer.alloc(16)), padding: 'PKCS7', data: b64(Buffer.alloc(16)) }).code,
    'OPERATION_FAILED');
  assert.equal(JSON.parse(new JsHostCrypto(hostRandom, memoryStorage()).request(42)).code, 'INVALID_REQUEST');
});

test('works behind NativeHostCryptoProvider and CryptoCompositions', () => {
  const { NativeHostCryptoProvider } = require('../../imessage/src/runtime/host-crypto-provider');
  const { CryptoCompositions } = require('../../imessage/src/crypto/compositions');
  const crypto = new CryptoCompositions(new NativeHostCryptoProvider(new JsHostCrypto(hostRandom, memoryStorage())));
  const keyId = crypto.generateKey({ algorithm: 'ec', namedCurve: 'p-256', usages: ['sign'], persistence: 'session' });
  const spec = { algorithm: 'ecdsa', hash: 'sha256', signatureFormat: 'raw' };
  const signature = crypto.sign(keyId, spec, new Uint8Array(data));
  assert.equal(signature.length, 64);
  assert.equal(crypto.verify(crypto.exportPublicKey(keyId, 'spki'), spec, new Uint8Array(data), signature), true);
  const large = new Uint8Array(600 * 1024).fill(7);
  assert.deepEqual(Buffer.from(crypto.digest('sha256', large)), nodeCrypto.createHash('sha256').update(large).digest());
  assert.equal(crypto.deleteKey(keyId), true);
});
