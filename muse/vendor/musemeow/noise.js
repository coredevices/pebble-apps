// Noise XX orchestration using Node's native X25519, SHA-256, HMAC, and AES-GCM.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey,
  diffieHellman, generateKeyPairSync } from 'node:crypto';
import { MuseError } from './errors.js';

const EMPTY = Buffer.alloc(0);
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const hash = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const mac = (key, ...parts) => { const h = createHmac('sha256', key); for (const p of parts) h.update(p); return h.digest(); };
export function hkdf(chainingKey, input) {
  const temp = mac(chainingKey, input);
  const first = mac(temp, Buffer.from([1]));
  const second = mac(temp, first, Buffer.from([2]));
  temp.fill(0);
  return [first, second];
}
export function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32) };
}
export function dh(pair, remote) {
  if (remote.length !== 32) throw new MuseError('invalid Noise public key');
  return diffieHellman({ privateKey: pair.privateKey,
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_PREFIX, remote]), format: 'der', type: 'spki' }) });
}
export class CipherState {
  #key; #nonce = 0n; #dead = false;
  constructor(key) { this.#key = key ? Buffer.from(key) : null; }
  #crypt(data, ad, decrypt) {
    if (this.#dead) throw new MuseError('cipher is closed');
    if (!this.#key) return Buffer.from(data);
    if (this.#nonce >= BigInt(Number.MAX_SAFE_INTEGER)) { this.destroy(); throw new MuseError('Noise nonce exhausted'); }
    const iv = Buffer.alloc(12); iv.writeBigUInt64BE(this.#nonce++, 4);
    try {
      const c = decrypt ? createDecipheriv('aes-256-gcm', this.#key, iv) : createCipheriv('aes-256-gcm', this.#key, iv);
      c.setAAD(ad);
      if (decrypt) {
        if (data.length < 16) throw new Error();
        c.setAuthTag(data.subarray(-16));
        return Buffer.concat([c.update(data.subarray(0, -16)), c.final()]);
      }
      return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
    } catch { this.destroy(); throw new MuseError('Noise cipher authentication failed'); }
  }
  encrypt(data, ad = EMPTY) { return this.#crypt(data, ad, false); }
  decrypt(data, ad = EMPTY) { return this.#crypt(data, ad, true); }
  destroy() { this.#key?.fill(0); this.#key = null; this.#dead = true; }
}
export class SymmetricState {
  #ck; #h; #cipher = new CipherState();
  constructor() {
    this.#h = Buffer.alloc(32); this.#h.write('Noise_XX_25519_AESGCM_SHA256');
    this.#ck = Buffer.from(this.#h); this.mixHash(EMPTY);
  }
  mixHash(data) { this.#h = hash(this.#h, data); }
  mixKey(input) {
    const [ck, key] = hkdf(this.#ck, input);
    this.#ck.fill(0); this.#ck = ck; this.#cipher.destroy(); this.#cipher = new CipherState(key); key.fill(0);
  }
  encryptAndHash(data) { const out = this.#cipher.encrypt(data, this.#h); this.mixHash(out); return out; }
  decryptAndHash(data) { const out = this.#cipher.decrypt(data, this.#h); this.mixHash(data); return out; }
  split() {
    const keys = hkdf(this.#ck, EMPTY);
    const states = keys.map(key => new CipherState(key)); keys.forEach(key => key.fill(0)); this.destroy(); return states;
  }
  destroy() { this.#ck.fill(0); this.#h.fill(0); this.#cipher.destroy(); }
}
export class NoiseInitiator {
  #s = new SymmetricState(); #e; #re; #remote; #phase = 0;
  writeHello(payload) {
    if (this.#phase !== 0) throw new MuseError('invalid Noise handshake phase');
    this.#e = keypair(); this.#s.mixHash(this.#e.publicKey); this.#phase = 1;
    return Buffer.concat([this.#e.publicKey, this.#s.encryptAndHash(payload)]);
  }
  readResponse(message) {
    if (this.#phase !== 1 || message.length < 96 || message.length > 65535) throw new MuseError('invalid Noise response');
    this.#re = message.subarray(0, 32); this.#s.mixHash(this.#re);
    let secret = dh(this.#e, this.#re); this.#s.mixKey(secret); secret.fill(0);
    this.#remote = this.#s.decryptAndHash(message.subarray(32, 80));
    secret = dh(this.#e, this.#remote); this.#s.mixKey(secret); secret.fill(0);
    const payload = this.#s.decryptAndHash(message.subarray(80)); this.#phase = 2;
    return { payload, serverPublicKey: Buffer.from(this.#remote) };
  }
  finish() {
    if (this.#phase !== 2) throw new MuseError('invalid Noise handshake phase');
    const pair = keypair(); const staticKey = this.#s.encryptAndHash(pair.publicKey);
    const secret = dh(pair, this.#re); this.#s.mixKey(secret); secret.fill(0);
    const message = Buffer.concat([staticKey, this.#s.encryptAndHash(EMPTY)]);
    const [send, receive] = this.#s.split(); this.#phase = 3; this.#e = null;
    return { message, send, receive };
  }
  destroy() { this.#s.destroy(); this.#e = null; this.#phase = -1; }
}
