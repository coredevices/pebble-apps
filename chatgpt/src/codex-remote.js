'use strict';

var util = require('./util');
var deviceKey = require('./device-key');
var codexHeaders = require('./codex-auth').codexHeaders;
var PluginError = util.PluginError;

var ORIGIN = 'https://chatgpt.com';
var BASE_PATH = '/backend-api/codex/remote/control';
var SOCKET_URL = 'wss://chatgpt.com' + BASE_PATH + '/client';
var PROTOCOL_VERSION = '3';
var KEY = 'chatgpt.codex.remote.v1';
var RENEW_BEFORE_MS = 60 * 1000;
var CLIENT_NAME = 'Pebble Plugin';
var CLIENT_INFO = { name: 'pebble_plugin', title: CLIENT_NAME, version: '1.0.0' };

function notConnected() {
  return PluginError('AUTH_REQUIRED', 'Connect your computers in the plugin settings first.');
}

function environmentName(env) {
  return env.name || env.rawDisplayName || env.raw_display_name || env.hostName || env.host_name || env.id;
}

/** A thread's label the way `codex queue` matches it: its name, else its first prompt. */
function threadLabel(thread) {
  return (thread.name && thread.name.trim()) || (thread.preview || '').trim() || thread.id;
}

function createCodexRemote(storage, fetch, now, WebSocketImpl, auth) {
  async function load() {
    var raw = await storage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  }

  async function call(account, method, path, body, clientId) {
    var headers = codexHeaders(account);
    headers['x-codex-protocol-version'] = PROTOCOL_VERSION;
    headers['x-codex-name'] = CLIENT_NAME;
    headers['User-Agent'] = CLIENT_NAME;
    if (clientId) headers['x-codex-client-id'] = clientId;
    var response = await fetch(ORIGIN + BASE_PATH + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) throw notConnected();
    if (response.status === 403) {
      throw PluginError('PERMISSION_DENIED', 'Codex remote control is not enabled for this ChatGPT account or workspace.');
    }
    if (response.status < 200 || response.status >= 300) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'Codex remote control returned an error (HTTP ' + response.status + ').');
    }
    return response.json();
  }

  async function save(finish, key, paired) {
    var session = {
      paired: !!paired,
      clientId: finish.client_id,
      accountUserId: finish.account_user_id,
      token: finish.remote_control_token,
      expiresAt: Date.parse(finish.expires_at) || now(),
      key: key,
    };
    await storage.setItem(KEY, JSON.stringify(session));
    return session;
  }

  /** Enrolls this phone as a remote-control client, authorized by a fresh step-up sign-in. */
  async function enroll(stepUpToken, seed) {
    var account = await auth.current();
    var start = await call(account, 'POST', '/client/enroll/start', {});
    var key = deviceKey.generate(start.account_user_id, start.client_id, seed);
    var proof = deviceKey.signEnrollment(key, start.device_key_challenge, ORIGIN, BASE_PATH + '/client/enroll/finish', false);
    var finish = await call(account, 'POST', '/client/enroll/finish', {
      client_id: start.client_id,
      step_up_token: stepUpToken,
      device_identity: deviceKey.identity(key),
      device_key_proof: proof,
    }, start.client_id);
    return save(finish, key);
  }

  async function current(account) {
    var session = await load();
    if (!session) throw notConnected();
    if (session.expiresAt - now() > RENEW_BEFORE_MS) return session;
    var start = await call(account, 'POST', '/client/refresh/start', { client_id: session.clientId }, session.clientId);
    var proof = deviceKey.signEnrollment(session.key, start.device_key_challenge, ORIGIN, BASE_PATH + '/client/refresh/finish', true);
    var finish = await call(account, 'POST', '/client/refresh/finish', {
      client_id: session.clientId,
      device_key_proof: proof,
    }, session.clientId);
    return save(finish, session.key, session.paired);
  }

  async function environments(account, session) {
    var body = await call(account, 'GET', '/environments', undefined, session.clientId);
    var list = Array.isArray(body) ? body : (body && (body.data || body.items || body.environments)) || [];
    return list.map(function (env) {
      return { id: env.id || env.env_id, name: environmentName(env), online: !!env.online, busy: !!env.busy };
    });
  }

  /** The signed-in user's computers, for the settings page. */
  async function computers() {
    var account = await auth.current();
    return environments(account, await current(account));
  }

  /** One relay socket to one computer's Codex app-server, speaking JSON-RPC through the envelopes. */
  function open(account, session, environmentId) {
    var streamId = util.uuid();
    var seq = 0;
    var cursor = null;
    var nextId = 1;
    var pending = {};
    var chunks = {};
    var failed = null;
    var ready;
    var socket = new WebSocketImpl(SOCKET_URL, [], {
      headers: {
        'Authorization': 'Bearer ' + account.accessToken,
        'chatgpt-account-id': account.account,
        'originator': 'Codex Desktop',
        'x-codex-protocol-version': PROTOCOL_VERSION,
        'x-codex-client-id': session.clientId,
        'x-codex-client-session-token': 'Bearer ' + session.token,
        'x-codex-name': CLIENT_NAME,
        'User-Agent': CLIENT_NAME,
      },
    });

    var handshake = new Promise(function (resolve, reject) { ready = { resolve: resolve, reject: reject }; });

    function fail(error) {
      if (failed) return;
      failed = error;
      ready.reject(error);
      Object.keys(pending).forEach(function (id) { pending[id].reject(error); });
      pending = {};
    }

    function deliver(message) {
      // The relay reports transport failures as an `error` notification, not as a reply to a request.
      if (message && message.method === 'error' && message.params && message.params.threadId === '__remote_control_transport__') {
        var reason = message.params.error && message.params.error.message;
        var unpaired = /not paired/i.test(reason || '');
        var transportError = PluginError('PLUGIN_UNAVAILABLE', unpaired
          ? 'That computer has not paired this phone for Codex remote control yet. Pair it in plugin settings.'
          : 'Codex remote control: ' + (reason || 'connection failed') + '.');
        transportError.unpaired = unpaired;
        fail(transportError);
        return;
      }
      if (message && message.id !== undefined && pending[message.id]) {
        var waiter = pending[message.id];
        delete pending[message.id];
        if (message.error) {
          var error = PluginError('PLUGIN_UNAVAILABLE', 'Codex: ' + (message.error.message || 'request failed') + '.');
          error.rpc = message.error;
          waiter.reject(error);
        } else {
          waiter.resolve(message.result);
        }
      }
    }

    socket.onmessage = function (event) {
      var envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (envelope.type === 'device_key_challenge') {
        try {
          socket.send(JSON.stringify(deviceKey.signConnection(session.key, envelope)));
          ready.resolve();
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (envelope.cursor) cursor = envelope.cursor;
      if (envelope.type === 'server_message') {
        deliver(envelope.message);
      } else if (envelope.type === 'server_message_chunk') {
        var parts = chunks[envelope.seq_id] = chunks[envelope.seq_id] || [];
        parts[envelope.segment_id] = envelope.message_chunk_base64;
        var complete = 0;
        for (var i = 0; i < envelope.segment_count; i++) if (parts[i] !== undefined) complete++;
        if (complete === envelope.segment_count) {
          delete chunks[envelope.seq_id];
          var bytes = [];
          parts.forEach(function (part) { bytes.push.apply(bytes, Array.from(util.fromBase64(part))); });
          deliver(JSON.parse(util.fromUtf8(new Uint8Array(bytes))));
        }
      }
    };
    socket.onerror = function () {
      fail(PluginError('PLUGIN_UNAVAILABLE', 'Could not reach Codex remote control.'));
    };
    socket.onclose = function () {
      fail(PluginError('PLUGIN_UNAVAILABLE', 'Codex remote control closed the connection.'));
    };

    function envelope(fields) {
      seq += 1;
      var out = { type: fields.type, client_id: session.clientId, env_id: environmentId, stream_id: streamId, seq_id: seq };
      if (fields.message) out.message = fields.message;
      if (cursor) out.cursor = cursor;
      socket.send(JSON.stringify(out));
    }

    function notify(method, params) {
      var message = { method: method };
      if (params) message.params = params;
      envelope({ type: 'client_message', message: message });
    }

    function request(method, params) {
      if (failed) return Promise.reject(failed);
      var id = nextId++;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        envelope({ type: 'client_message', message: { id: id, method: method, params: params } });
      });
    }

    async function start() {
      await handshake;
      await request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } });
      notify('initialized');
    }

    function close() {
      try {
        if (!failed) envelope({ type: 'client_closed' });
        socket.close(1000, '');
      } catch (_) { /* already closed */ }
    }

    return { start: start, request: request, close: close };
  }

  function pickComputer(list, query) {
    var online = list.filter(function (env) { return env.online; });
    if (!online.length) {
      throw PluginError('PLUGIN_UNAVAILABLE', list.length
        ? 'None of your computers is online for Codex remote control.'
        : 'No computer is set up for Codex remote control. Turn on remote control in the Codex app or run `codex remote-control start`.');
    }
    return util.pick(online, query, function (env) { return env.name; }, 'computer');
  }

  async function threadsOn(link) {
    var listed = await link.request('thread/list', { limit: 50, sortKey: 'updated_at', archived: false });
    return (listed && listed.data || []).filter(function (thread) { return !thread.ephemeral; });
  }

  /** Each online computer's recent sessions, as chats: id, computer, label, state and last activity. */
  // ponytail: one computer at a time; run them in parallel if multi-computer listing outgrows agent/chats' timeout.
  async function chats() {
    var account = await auth.current();
    var session = await current(account);
    var all = await environments(account, session);
    var online = all.filter(function (env) { return env.online; });
    if (!online.length) pickComputer(all);
    var found = [];
    var unpaired = null;
    var reached = false;
    for (var i = 0; i < online.length; i++) {
      var link = open(account, session, online[i].id);
      try {
        await link.start();
        reached = true;
        (await threadsOn(link)).slice(0, 20).forEach(function (thread) {
          var state = thread.status && thread.status.type;
          found.push({
            kind: 'session',
            id: thread.id,
            computer: online[i].name,
            label: threadLabel(thread).slice(0, 80),
            state: state === 'active' ? 'working' : state === 'idle' ? 'open' : 'not open',
            updatedAt: util.toMillis(thread.recencyAt || thread.updatedAt),
          });
        });
      } catch (error) {
        // A computer that hasn't paired this phone just isn't listed, unless none has.
        if (!error.unpaired) throw error;
        unpaired = error;
      } finally {
        link.close();
      }
    }
    if (!reached && unpaired) throw unpaired;
    if (reached && !session.paired) await markPaired(session);
    return found;
  }

  /** Puts [message] into one of the computer's Codex sessions, starting it if the session is idle. */
  async function send(args) {
    var text = args && args.message;
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) {
      throw PluginError('INVALID_ARGS', 'Provide a message between 1 and 16,000 characters.');
    }
    var account = await auth.current();
    var session = await current(account);
    var computer = pickComputer(await environments(account, session), args.computer);
    var link = open(account, session, computer.id);
    try {
      await link.start();
      var threads = await threadsOn(link);
      if (!args.session) {
        // With no session named, prefer one that is open over one only on disk.
        var loaded = threads.filter(function (thread) { return thread.status && thread.status.type !== 'notLoaded'; });
        if (loaded.length) threads = loaded;
      }
      var thread = util.pick(threads, args.session, threadLabel, 'Codex session on ' + computer.name);
      // The app-server starts a queued message itself once its thread is loaded and idle.
      await link.request('thread/queue/add', {
        threadId: thread.id,
        input: [{ type: 'text', text: text, textElements: [] }],
        clientUserMessageId: util.uuid(),
      });
      var label = '"' + threadLabel(thread).slice(0, 60) + '" on ' + computer.name;
      var state = thread.status && thread.status.type;
      if (state === 'idle') return { text: 'Sent to Codex session ' + label + '.' };
      if (state === 'active') return { text: 'Queued for Codex session ' + label + '; it runs after the current turn.' };
      return { text: 'Queued for Codex session ' + label + '; it runs when the session is next opened.' };
    } finally {
      link.close();
    }
  }

  async function markPaired(session) {
    session.paired = true;
    await storage.setItem(KEY, JSON.stringify(session));
  }

  /**
   * Pairs this phone with one computer, from the code the computer shows: a manual code like
   * ABCD-EFGH (`codex remote-control pair`), or the QR code's text or link.
   */
  async function pair(input) {
    var text = typeof input === 'string' ? input.trim() : '';
    var fromLink = text.match(/[?&#](?:manual_pairing_code|pairing_code|code)=([^&#]+)/i);
    var code = fromLink ? decodeURIComponent(fromLink[1]) : text;
    if (!code || code.length > 512 || /\s/.test(code)) {
      throw PluginError('INVALID_ARGS', 'Paste the pairing code your computer shows.');
    }
    var manual = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code);
    var account = await auth.current();
    var session = await current(account);
    var body = { client_id: session.clientId };
    body[manual ? 'manual_pairing_code' : 'pairing_code'] = manual ? code.toUpperCase() : code;
    try {
      await call(account, 'POST', '/client/pair', body, session.clientId);
    } catch (error) {
      if (/HTTP 4\d\d/.test(error.message)) {
        throw PluginError('INVALID_ARGS', 'That pairing code did not work. Codes expire after a few minutes; get a new one.');
      }
      throw error;
    }
    await markPaired(session);
    return environments(account, session);
  }

  async function disconnect() {
    await storage.removeItem(KEY);
  }

  return { load: load, enroll: enroll, computers: computers, chats: chats, pair: pair, send: send, disconnect: disconnect };
}

module.exports = { createCodexRemote: createCodexRemote };
