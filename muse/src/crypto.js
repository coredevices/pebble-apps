import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { x25519 } from "@noble/curves/ed25519";
import { gcm } from "@noble/ciphers/aes";

// Android plugin engines have Web Crypto; iOS has no secure source, so it falls back to Math.random.
export function randomBytes(length) {
  if (globalThis.crypto?.getRandomValues) {
    return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(length)));
  }
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}
export function randomUUID() {
  const b = randomBytes(16);
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export function createHash() {
  const h = sha256.create();
  return { update: (b) => h.update(b), digest: () => Buffer.from(h.digest()) };
}
export function createHmac(_, key) {
  const h = hmac.create(sha256, key);
  return { update: (b) => h.update(b), digest: () => Buffer.from(h.digest()) };
}
export function generateKeyPairSync() {
  const privateKey = randomBytes(32);
  const bytes = Buffer.from(x25519.getPublicKey(privateKey));
  return { privateKey, publicKey: { export: () => bytes } };
}
export function createPublicKey({ key }) {
  return key.subarray(-32);
}
export function diffieHellman({ privateKey, publicKey }) {
  return Buffer.from(x25519.getSharedSecret(privateKey, publicKey));
}
function cipher(key, iv, decrypt) {
  let ad, tag, data, result;
  return {
    setAAD: (value) => {
      ad = value;
    },
    setAuthTag: (value) => {
      tag = value;
    },
    update: (value) => {
      data = value;
      return Buffer.alloc(0);
    },
    final() {
      const c = gcm(key, iv, ad);
      result = Buffer.from(
        decrypt ? c.decrypt(Buffer.concat([data, tag])) : c.encrypt(data),
      );
      return decrypt ? result : result.subarray(0, -16);
    },
    getAuthTag: () => result.subarray(-16),
  };
}
export function createCipheriv(_, key, iv) {
  return cipher(key, iv, false);
}
export function createDecipheriv(_, key, iv) {
  return cipher(key, iv, true);
}
