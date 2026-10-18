import { randomBytes } from 'node:crypto';
import { encode, decode } from './wire.js';
import { MuseError } from './errors.js';
export const MAX_CHUNK = 65489;
export const MAX_BODY = 16 * 1024 * 1024;

export class FrameDecoder {
  #pending = new Map(); #dead = false;
  decode(bytes) {
    if (this.#dead) throw new MuseError('frame decoder is closed');
    try {
      const f = decode('TransportFrame', bytes);
      const total = Object.hasOwn(f, 'totalChunks') ? f.totalChunks : 1;
      const index = f.chunkIndex ?? 0; const id = (f.chunkId ?? 0).toString();
      if (total < 1 || total > 256 || index >= total || (f.payload?.length ?? 0) > MAX_CHUNK) throw new Error();
      const now = Date.now();
      for (const [key, value] of this.#pending) if (now - value.created > 60_000) this.#pending.delete(key);
      let a = this.#pending.get(id);
      if (!a) {
        if (this.#pending.size >= 16) throw new Error();
        a = { total, chunks: new Map(), size: 0, created: now }; this.#pending.set(id, a);
      }
      if (a.total !== total || a.chunks.has(index)) throw new Error();
      const payload = Buffer.from(f.payload ?? []);
      a.size += payload.length; if (a.size > MAX_BODY) throw new Error(); a.chunks.set(index, payload);
      if (a.chunks.size !== total) return null;
      this.#pending.delete(id);
      return Buffer.concat(Array.from({ length: total }, (_, i) => a.chunks.get(i)), a.size);
    } catch { this.destroy(); throw new MuseError('invalid transport chunks'); }
  }
  destroy() { this.#pending.clear(); this.#dead = true; }
}
export function framePayload(payload) {
  const n = Math.max(1, Math.ceil(payload.length / MAX_CHUNK));
  if (payload.length > MAX_BODY || n > 256) throw new MuseError('request too large');
  const id = randomBytes(8).readBigInt64LE().toString();
  return Array.from({ length: n }, (_, i) => encode('TransportFrame', {
    chunkId: id, chunkIndex: i, totalChunks: n, payload: payload.subarray(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
  }));
}
export class Transport {
  #send; #receive; #decoder = new FrameDecoder(); #dead = false;
  constructor(send, receive) { this.#send = send; this.#receive = receive; }
  encrypt(request) {
    if (this.#dead) throw new MuseError('transport is closed');
    try { return framePayload(encode('ServiceRequest', { service: 0, payload: encode('ServiceFrame', request) })).map(b => this.#send.encrypt(b)); }
    catch { this.destroy(); throw new MuseError('request encryption failed'); }
  }
  decrypt(bytes) {
    if (this.#dead) throw new MuseError('transport is closed');
    try {
      const b = this.#decoder.decode(this.#receive.decrypt(bytes)); if (!b) return null;
      const response = decode('ServiceResponse', b); if (!response.payload?.length) throw new Error();
      const frame = decode('ServiceFrame', response.payload);
      if (['request', 'response', 'bodyChunk', 'reset'].filter(k => Object.hasOwn(frame, k)).length !== 1 || frame.request) throw new Error();
      return frame;
    } catch { this.destroy(); throw new MuseError('invalid encrypted response'); }
  }
  destroy() { this.#dead = true; this.#send.destroy(); this.#receive.destroy(); this.#decoder.destroy(); }
}
