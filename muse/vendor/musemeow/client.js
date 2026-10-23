import { rest } from '../../src/platform.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { authValues } from './auth.js';
import { MuseError, HTTPError } from './errors.js';
import { NoiseInitiator } from './noise.js';
import { encode, decode } from './wire.js';
import { Transport, MAX_BODY } from './transport.js';
import { Socket } from './socket.js';
import { chatInfo, validateChatId, sessionResult } from './chats.js';

const ORIGIN = 'https://muse.ai';
const ENDPOINT = 'wss://hatch.metaaivm.com/v1/noise';
function endpoints(origin, endpoint) {
  if (origin !== ORIGIN || endpoint !== ENDPOINT) throw new MuseError('invalid endpoints');
}
const queryString = values => Object.entries(values).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
/** Standard-VM Muse client. Requests are serialized; sends are never retried. */
export class MuseClient {
  #auth; #origin; #endpoint; #socket; #transport; #stream = 0;
  #tail = Promise.resolve(); #active; #generation = 0;
  constructor(auth, { origin = ORIGIN, endpoint = ENDPOINT } = {}) {
    this.#auth = authValues(auth); this.#auth.node_id ||= randomUUID();
    try { endpoints(origin, endpoint); } catch { throw new MuseError('invalid endpoint configuration'); }
    this.#origin = origin; this.#endpoint = endpoint;
  }
  #run(fn, { signal } = {}, timeout = 60_000) {
    const generation = this.#generation;
    const task = this.#tail.then(async () => {
      if (generation !== this.#generation || signal?.aborted) throw new MuseError('operation aborted');
      const controller = new AbortController(); this.#active = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort);
      const timer = setTimeout(abort, timeout);
      const combined = controller.signal;
      try { return await fn(combined); }
      catch (error) { this.#disconnect(); if (error instanceof MuseError) throw error; throw new MuseError('operation failed; delivery may be uncertain'); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#active = null; }
    });
    this.#tail = task.catch(() => {}); return task;
  }
  #disconnect() { this.#socket?.close(); this.#socket = null; this.#transport?.destroy(); this.#transport = null; }
  /** Interrupt active and queued operations; a subsequent connect can start fresh. */
  close() { this.#generation++; this.#active?.abort(); this.#disconnect(); }
  async #rest(path, body, signal) {
    return rest(this.#origin, this.#auth.cookie, path, body, signal);
  }

  /** Wake, mint a fresh one-use token, then complete Noise XX over verified TLS. */
  connect(options) {
    return this.#run(async signal => {
      this.#disconnect();
      await this.#rest('vm/wake', { vm_id: this.#auth.vm_id, retry_count: 0, connect_attempt_id: randomUUID() }, signal);
      const admission = await this.#rest('token', { vmAddress: `${this.#auth.vm_id}.metaaivm.com`, force_refresh: true }, signal);
      if (!admission || typeof admission.token !== 'string' || !admission.token) throw new MuseError('missing admission token');
      const url = this.#endpoint + "?" + queryString({ vm_id: this.#auth.vm_id, auth_token: admission.token, app_id: 'hatch-web', request_id: randomUUID(),
        ...(typeof admission.notary_token === 'string' && admission.notary_token ? { notary_token: admission.notary_token } : {}) });
      const socket = this.#socket = new Socket(url, this.#origin); await socket.open(signal);
      const hs = new NoiseInitiator();
      try {
        await socket.write(hs.writeHello(encode('ClientHello', { clientNonce: randomBytes(32) })), signal);
        const { payload, serverPublicKey } = hs.readResponse(await socket.read(signal));
        if (this.#auth.pin && !timingSafeEqual(this.#auth.pin, serverPublicKey)) throw new MuseError('Noise server key does not match pin');
        let rv; try { rv = decode('RVChallenge', payload); } catch { /* Standard opaque attestation payload. */ }
        if (rv && [1, 2].includes(rv.state) && rv.vmNonce?.length === 32) throw new MuseError('confidential VM RV authentication and attestation are unsupported');
        const { message, send, receive } = hs.finish();
        this.#transport = new Transport(send, receive);
        await socket.write(message, signal); this.#stream = 0;
      } finally { hs.destroy(); }
    }, options, 45_000);
  }
  /** List existing chat metadata. view is 'active' (default) or 'archived'. */
  listChats({ view = 'active', signal } = {}) {
    if (!['active', 'archived'].includes(view)) return Promise.reject(new MuseError('chat view must be active or archived'));
    return this.#run(async signal => {
      const path = '/api/session/list' + (view === 'archived' ? '?view=archived' : '');
      const result = sessionResult(await this.#request('GET', path, null, false, signal));
      if (!result || !Array.isArray(result.sessions)) throw new MuseError('invalid chat list response');
      return result.sessions.map(chatInfo);
    }, { signal });
  }
  /** Refresh one chat's metadata from the server, rather than trusting a cached list. */
  getChat(chatId, options) {
    try { validateChatId(chatId); } catch (error) { return Promise.reject(error); }
    return this.#run(signal => this.#chat(chatId, signal), options);
  }
  async #chat(chatId, signal) {
    const result = sessionResult(await this.#request('GET', `/api/session/list/${encodeURIComponent(chatId)}`, null, false, signal));
    const chat = chatInfo(result?.session_id === undefined ? result?.session : result);
    if (chat.session_id !== chatId) throw new MuseError('chat lookup returned a different session_id');
    return chat;
  }
  /** Send to an existing chat selected by session_id from listChats(). */
  sendToChat(chatId, text, options) {
    try { validateChatId(chatId); this.#validateText(text); } catch (error) { return Promise.reject(error); }
    return this.#run(async signal => {
      const chat = await this.#chat(chatId, signal);
      if (!chat.can_send) throw new MuseError('this chat cannot receive messages through the Muse web client');
      options?.beforeSend?.();
      return this.#send(text, chat.is_primary ? undefined : chat.session_id, signal);
    }, options);
  }
  /** Return the acceptance receipt, without waiting for the assistant's full reply. */
  sendMain(text, options) {
    try { this.#validateText(text); } catch (error) { return Promise.reject(error); }
    return this.#run(signal => { options?.beforeSend?.(); return this.#send(text, undefined, signal); }, options);
  }
  #validateText(text) {
    if (typeof text !== 'string' || !text.trim()) throw new MuseError('message is empty');
    if (Buffer.byteLength(text) > MAX_BODY - 1024) throw new MuseError('message is too large');
  }
  async #send(text, sessionId, signal) {
    const body = { message: text, node_id: this.#auth.node_id, ...(sessionId === undefined ? {} : { session_id: sessionId }) };
    const result = await this.#request('POST', '/chat/stream', body, true, signal);
    if (!result || typeof result.message_id !== 'string' || !result.message_id) throw new MuseError('missing message acknowledgment; delivery uncertain');
    if (sessionId !== undefined && result.session_id !== undefined && result.session_id !== sessionId) {
      throw new MuseError('message acknowledgment has a different session_id; delivery uncertain');
    }
    return result;
  }
  /** Return decoded history, optionally scoped to an existing chat via options.chatId. */
  history(limit = 20, { chatId, signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return Promise.reject(new MuseError('history limit must be 1..100'));
    if (chatId !== undefined) { try { validateChatId(chatId); } catch (error) { return Promise.reject(error); } }
    return this.#run(async signal => {
      const query = { limit: String(limit) };
      if (chatId !== undefined) {
        const chat = await this.#chat(chatId, signal);
        if (!chat.is_primary) query.session_id = chat.session_id;
      }
      return this.#request('GET', `/chat/history?${queryString(query)}`, null, false, signal);
    }, { signal });
  }
  async #request(verb, path, body, firstJSON, signal) {
    if (!this.#socket || !this.#transport) throw new MuseError('not connected');
    const socket = this.#socket; const transport = this.#transport; const stream = ++this.#stream;
    const headers = [{ key: 'x-app-id', value: 'hatch-web' }, { key: 'x-request-id', value: randomUUID() }, { key: 'Accept-Language', value: 'en-US' }];
    if (body !== null) headers.push({ key: 'Content-Type', value: 'application/json' });
    const frames = transport.encrypt({ streamId: stream, request: { verb, path, headers,
      body: body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)), endBody: true } });
    for (const frame of frames) await socket.write(frame, signal);
    const parts = []; let size = 0; let status = 0;
    for (;;) {
      const frame = transport.decrypt(await socket.read(signal));
      if (!frame || frame.streamId.toString() !== String(stream)) continue;
      let data; let end;
      if (frame.response) {
        if (status) throw new MuseError('duplicate response header');
        status = frame.response.status; data = frame.response.body; end = frame.response.endBody;
      } else if (frame.bodyChunk) {
        if (!status) throw new MuseError('body arrived before response header');
        data = frame.bodyChunk.data; end = frame.bodyChunk.endBody;
      } else throw new MuseError('server reset request; delivery uncertain');
      if (status < 200 || status >= 300) throw new HTTPError('chat request', status);
      data = Buffer.from(data ?? []);
      size += data.length; if (size > MAX_BODY) throw new MuseError('response exceeds limit'); parts.push(data);
      if (firstJSON || end) {
        const text = Buffer.concat(parts, size).toString('utf8').trim();
        try { return JSON.parse(text); } catch { /* It may still be incomplete NDJSON. */ }
        if (firstJSON && text.includes('\n')) { try { return JSON.parse(text.slice(0, text.indexOf('\n'))); } catch { /* Wait for more data. */ } }
        if (end) throw new MuseError('invalid chat response JSON; delivery uncertain');
      }
    }
  }
}
