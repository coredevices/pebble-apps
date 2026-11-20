'use strict';

var sha3_512 = require('@noble/hashes/sha3.js').sha3_512;
var util = require('./util');
var PluginError = util.PluginError;

var API = 'https://chatgpt.com/backend-api';
var DEVICE_KEY = 'chatgpt.web.device.v1';
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var DATA_BUILD = 'prod-329d9af90bc80a50b17d4b6f95c261f7c70f5a9b';
// Leaves the rest of the host's 20 s action limit for the requests and ChatGPT's reply.
var POW_BUDGET_MS = 5000;
// Reads for a just-posted message while ChatGPT's reply streams. ChatGPT saved one ~2.3 s after the POST
// (November 18, 2026); plugins have no timers, so back-to-back reads are bounded by time and count.
var TURN_WAIT_MS = 10000, TURN_READS = 30;

function needsBrowser() {
  return PluginError('PERMISSION_DENIED', 'ChatGPT wants a browser check before taking this message. Send it from the ChatGPT app.');
}

function checkText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 16000) {
    throw PluginError('INVALID_ARGS', 'Provide a message between 1 and 16,000 characters.');
  }
}

function failure(status) {
  if (status === 401) return PluginError('AUTH_REQUIRED', 'ChatGPT sign-in expired. Sign in again in plugin settings.');
  if (status === 403) return PluginError('PERMISSION_DENIED', 'ChatGPT blocked this message from the plugin. Send it from the ChatGPT app.');
  if (status === 404) return PluginError('INVALID_ARGS', 'ChatGPT could not find that chat.');
  if (status === 429) return PluginError('RATE_LIMITED', 'ChatGPT usage limit reached. Try again later.');
  return PluginError('PLUGIN_UNAVAILABLE', 'ChatGPT returned an error (HTTP ' + status + '). If sending, check the chat before trying again.');
}

/** The browser fingerprint the sentinel's proof of work hashes; [3] and [9] are the attempt counters. */
function browserConfig(now) {
  return [
    4000, new Date(now()).toString(), null, 0, USER_AGENT, null, DATA_BUILD, 'en-US', 'en-US,en', 0,
    'webdriver−false', 'location', 'ontransitionend', Math.random() * 1000, util.uuid(), '', 8, Math.floor(now() / 1000),
  ];
}

/** The base64 config whose sha3-512 after [seed] starts at or below [difficulty], or null if the budget runs out. */
function solve(seed, difficulty, config, now) {
  var target = difficulty.toLowerCase();
  var deadline = now() + POW_BUDGET_MS;
  for (var i = 0; ; i++) {
    if (i % 1000 === 999 && now() > deadline) return null;
    config[3] = i;
    config[9] = i >> 1;
    var answer = util.base64(util.utf8(JSON.stringify(config)));
    var hash = sha3_512(util.utf8(seed + answer));
    var hex = '';
    for (var j = 0; hex.length < target.length; j++) hex += ('0' + hash[j].toString(16)).slice(-2);
    if (hex.slice(0, target.length) <= target) return answer;
  }
}

/** The conversation id and the assistant's reply in a /f/conversation event stream (v1 deltas or full snapshots). */
function parseStream(body) {
  var result = { conversation: null, reply: '', done: false, error: false };
  var current = null;
  var path = null;
  var op = null;
  function start(event) {
    var m = event.message;
    if (event.conversation_id) result.conversation = event.conversation_id;
    var parts = m.content && m.content.parts;
    current = m.author && m.author.role === 'assistant' && m.recipient === 'all' && parts && m.content.content_type === 'text'
      ? { text: parts && typeof parts[0] === 'string' ? parts[0] : '' } : null;
    if (current) result.last = current;
  }
  function apply(p, o, v) {
    if (p === '' && o === 'add' && v && typeof v.message === 'object') start(v);
    else if (current && p === '/message/content/parts/0' && typeof v === 'string') current.text = o === 'append' ? current.text + v : v;
  }
  body.split('\n').forEach(function (line) {
    if (line.trim() === 'data: [DONE]') result.done = true;
    if (line.indexOf('data: ') !== 0) return;
    var event;
    try { event = JSON.parse(line.slice(6)); } catch (_) { return; }
    if (!event || typeof event !== 'object') return;
    if (event.conversation_id && !result.conversation) result.conversation = event.conversation_id;
    if (event.type === 'message_stream_complete') result.done = true;
    if (event.error) result.error = true;
    if (event.message && typeof event.message === 'object') return start(event);
    if (!('v' in event)) return;
    if ('p' in event) path = event.p;
    if ('o' in event) op = event.o;
    if (Array.isArray(event.v)) event.v.forEach(function (d) { if (d) apply(d.p, d.o, d.v); });
    else apply(path, op, event.v);
  });
  result.reply = result.last ? result.last.text.trim() : '';
  delete result.last;
  return result;
}

function millis(value) {
  return typeof value === 'string' ? Date.parse(value) || 0 : util.toMillis(value);
}

/** Standard chatgpt.com conversations, sent to as the web app does, with the Codex sign-in's ChatGPT session. */
function createChatGptChats(storage, fetch, now, auth) {
  async function deviceId() {
    var id = await storage.getItem(DEVICE_KEY);
    if (id) return id;
    id = util.uuid();
    await storage.setItem(DEVICE_KEY, id);
    return id;
  }

  async function call(session, method, path, body, extra) {
    var response = await fetch(API + path, {
      method: method,
      headers: Object.assign({
        'Authorization': 'Bearer ' + session.account.accessToken,
        'ChatGPT-Account-Id': session.account.account,
        'oai-device-id': session.device,
        'oai-language': 'en-US',
        'User-Agent': USER_AGENT,
        'Origin': 'https://chatgpt.com',
        'Referer': 'https://chatgpt.com/',
        'Content-Type': 'application/json',
      }, extra),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status < 200 || response.status >= 300) {
      console.error('ChatGPT ' + method + ' ' + path.split('?')[0].replace(/\/conversation\/[^/]+$/, '/conversation/:id') + ': HTTP ' + response.status);
      throw failure(response.status);
    }
    return response;
  }

  async function signedIn() {
    return { account: await auth.current(), device: await deviceId() };
  }

  async function list() {
    var session = await signedIn();
    var body = await (await call(session, 'GET', '/conversations?offset=0&limit=20&order=updated')).json();
    return (body && body.items || []).filter(function (c) { return c && c.id && !c.is_archived; }).map(function (c) {
      return { kind: 'chat', id: c.id, label: String(c.title || 'New chat').slice(0, 80), state: 'chatgpt', updatedAt: millis(c.update_time || c.create_time) };
    });
  }

  /**
   * The chat-requirements token and, when asked for, the proof of work. A turnstile flag is sent through
   * without a token, as ChatGPT usually still accepts it; an Arkose check can't be, so it refuses.
   */
  async function sentinel(session) {
    var config = browserConfig(now);
    var p = solve(String(Math.random()), '0fffff', config, now);
    if (!p) throw needsBrowser();
    var req = await (await call(session, 'POST', '/sentinel/chat-requirements', { p: 'gAAAAAC' + p })).json();
    if (!req || !req.token) throw PluginError('PLUGIN_UNAVAILABLE', 'ChatGPT did not accept a new message. Try again later.');
    console.log('ChatGPT chat requirements: proof of work ' + !!(req.proofofwork && req.proofofwork.required) +
      ', turnstile ' + !!(req.turnstile && req.turnstile.required) + ', arkose ' + !!(req.arkose && req.arkose.required));
    if (req.arkose && req.arkose.required) throw needsBrowser();
    var headers = { 'openai-sentinel-chat-requirements-token': req.token };
    var pow = req.proofofwork;
    if (pow && pow.required) {
      var answer = typeof pow.seed === 'string' && typeof pow.difficulty === 'string' && solve(pow.seed, pow.difficulty, config, now);
      if (!answer) throw needsBrowser();
      headers['openai-sentinel-proof-token'] = 'gAAAAAB' + answer;
    }
    return headers;
  }

  async function recent(session) {
    var body = await (await call(session, 'GET', '/conversations?offset=0&limit=5&order=updated')).json();
    return (body && body.items || []).map(function (c) { return c && c.id; }).filter(Boolean);
  }

  /**
   * The chat holding user message [messageId] once ChatGPT has saved it, null if not yet, or false once
   * [more] refuses another read; a new chat is one not in [known].
   */
  async function savedIn(session, id, messageId, known, more) {
    if (!id && !more()) return false;
    var ids = id ? [id] : (await recent(session)).filter(function (c) { return !known[c]; });
    for (var i = 0; i < ids.length; i++) {
      if (!more()) return false;
      var detail = await (await call(session, 'GET', '/conversation/' + encodeURIComponent(ids[i]))).json();
      var node = detail && detail.mapping && detail.mapping[messageId];
      if (node && node.message && node.message.author && node.message.author.role === 'user') return ids[i];
    }
    return null;
  }

  /** Sends to [args.conversation], or starts a new chat without one; the receipt never quotes the reply. */
  async function send(args) {
    checkText(args && args.message);
    var session = await signedIn();
    var id = args.conversation;
    var parent = 'client-created-root';
    var known = Object.create(null), watch = true;
    if (id) {
      var detail = await (await call(session, 'GET', '/conversation/' + encodeURIComponent(id))).json();
      parent = detail && detail.current_node;
      if (!parent) throw PluginError('PLUGIN_UNAVAILABLE', 'ChatGPT returned an incomplete chat.');
    } else {
      // A new chat's id only arrives in the stream, so it is found as a chat that wasn't listed before.
      try { (await recent(session)).forEach(function (c) { known[c] = true; }); } catch (_) { watch = false; }
    }
    var headers = await sentinel(session);
    var turn = {
      action: 'next', parent_message_id: parent, model: 'auto', conversation_mode: { kind: 'primary_assistant' },
      supports_buffering: true, supported_encodings: ['v1'],
    };
    if (id) turn.conversation_id = id;
    var prepared = await (await call(session, 'POST', '/f/conversation/prepare', Object.assign({ client_prepare_state: 'none' }, turn))).json();
    if (!prepared || !prepared.conduit_token) throw PluginError('PLUGIN_UNAVAILABLE', 'ChatGPT did not accept a new message. Try again later.');
    headers['x-conduit-token'] = prepared.conduit_token;
    headers['Accept'] = 'text/event-stream';
    var message = {
      id: util.uuid(), author: { role: 'user' }, create_time: now() / 1000,
      content: { content_type: 'text', parts: [args.message] }, metadata: {},
    };
    function receipt(conversation) {
      var text = id ? 'Sent to ChatGPT chat "' + String(args.title || id).slice(0, 60) + '".' : 'Started a new ChatGPT chat (chat_id ' + conversation + ').';
      return { text: text, semanticResult: util.messageSent(String(args.title || 'ChatGPT'), id || conversation, args.message) };
    }
    // CoreApp's fetch resolves only after ChatGPT's whole reply has streamed, which a long reply makes
    // outlast the host's 20 s action limit, so the chat is read for the saved message meanwhile.
    var posted = call(session, 'POST', '/f/conversation', Object.assign({ messages: [message], client_prepare_state: 'success' }, turn), headers);
    var body = posted.then(function (response) { return response.text(); }), settled = false, failed = false;
    posted.catch(function () { failed = true; });
    body.then(function () { settled = true; }, function () { settled = true; });
    // ponytail: back-to-back reads (~3/s on a phone) since plugins have no timers; space them if the host adds one.
    var reads = 0, until = now() + TURN_WAIT_MS;
    function more() { return !settled && reads++ < TURN_READS && now() < until; }
    // A stream that ends while a read is still out decides at once.
    var ended = body.then(function () { return false; }, function () { return false; });
    try {
      while (watch) {
        var saved = await Promise.race([savedIn(session, id, message.id, known, more), ended]);
        if (failed || saved === false) break; // A refused POST is reported as before, whatever a read showed.
        if (saved) return receipt(saved);
      }
    } catch (_) { /* A failed read (a rate limit included) stops reading; the stream decides. */ }
    await posted;
    var stream = parseStream(await body);
    if (!stream.conversation || (stream.error && !stream.reply)) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'ChatGPT did not confirm the message; check the chat before sending again.');
    }
    return receipt(stream.conversation);
  }

  return { list: list, send: send };
}

module.exports = { createChatGptChats: createChatGptChats };
