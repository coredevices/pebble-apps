'use strict';

var KEY = 'claude.connection.v1';
var ORIGIN = 'https://claude.ai';
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var CODE_ID = /^(?:cse_|session_)[A-Za-z0-9_-]{1,120}$/;
// Parent of the first message in a conversation.
var ROOT_MESSAGE = '00000000-0000-4000-8000-000000000000';
var MODES = ['new_chat', 'default_chat'];
var KINDS = ['claude', 'code'];
// chat_id values that always start a new Claude chat; not usable as nicknames.
var NEW_CHAT = ['new', 'new chat'];

function PluginError(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}
function invalid(message) { return PluginError('INVALID_ARGS', message); }
function unavailable() {
  return PluginError('PLUGIN_UNAVAILABLE', 'Claude returned an unexpected response. Open Claude to check the session.');
}
function uncertain() {
  return PluginError('PLUGIN_UNAVAILABLE', 'Delivery is uncertain. Check this session in Claude before sending again; do not automatically retry.');
}
function validCookie(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\s;\x00-\x1f\x7f]/.test(value);
}
function sessionRef(value) {
  if (typeof value !== 'string') throw invalid('Choose a Claude session.');
  var parts = value.split(':');
  if (parts.length !== 2 || !((parts[0] === 'chat' && UUID.test(parts[1])) ||
      (parts[0] === 'code' && CODE_ID.test(parts[1])))) throw invalid('Use a chat id from agent/chats.');
  return { kind: parts[0], id: parts[1], ref: value };
}
function requestId() {
  var bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  var hex = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}
function chatBranch(chat) {
  if (!chat || !Array.isArray(chat.chat_messages)) throw unavailable();
  var byId = Object.create(null);
  chat.chat_messages.forEach(function (m) { if (m && UUID.test(m.uuid)) byId[m.uuid] = m; });
  var leaf = chat.current_leaf_message_uuid;
  if (!UUID.test(leaf)) throw unavailable();
  var messages = [], seen = Object.create(null), cursor = leaf;
  while (byId[cursor]) {
    if (seen[cursor]) throw unavailable();
    seen[cursor] = true;
    messages.push(byId[cursor]);
    cursor = byId[cursor].parent_message_uuid;
  }
  if (messages.length === 0) throw unavailable();
  return { leaf: leaf, messages: messages.reverse() };
}
function completionReceipt(body, assistantId, humanId) {
  var receipt = null, failed = false, stopped = false;
  String(body).split(/\r?\n\r?\n/).forEach(function (frame) {
    var data = frame.split(/\r?\n/).filter(function (line) { return line.indexOf('data:') === 0; })
      .map(function (line) { return line.slice(5).trim(); }).join('\n');
    if (!data || data === '[DONE]') return;
    try {
      var event = JSON.parse(data);
      if (event.type === 'error' || event.error) failed = true;
      if (event.type === 'message_stop') stopped = true;
      if (event.type === 'message_start' && event.message) {
        var message = event.message;
        if (message.uuid === assistantId || message.id === assistantId) receipt = humanId;
        // Claude may replace both requested UUIDs with server-generated UUIDs.
        else if (message.role === 'assistant' && UUID.test(message.uuid) && UUID.test(message.parent_uuid)) receipt = message.parent_uuid;
      }
    } catch (_) { /* Ignore non-JSON SSE frames. */ }
  });
  return !failed && stopped ? receipt : null;
}

function createService(storage, fetch, now) {
  var sending = false;
  async function load() {
    var raw = await storage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  }
  function save(state) { return storage.setItem(KEY, JSON.stringify(state)); }
  async function required() {
    var state = await load();
    if (!state) throw PluginError('AUTH_REQUIRED', 'Sign in with Claude in plugin settings.');
    return state;
  }
  function orgPath(state) {
    if (!UUID.test(state.org)) throw invalid('Choose an organization in plugin settings.');
    return '/api/organizations/' + state.org;
  }
  function nicknames(state) {
    return state.nicknamesByOrg && state.nicknamesByOrg[state.org] || {};
  }
  function nickname(state, id) { return nicknames(state)[id] || ''; }
  // Whether a message with no chat named goes to Claude chats or Claude Code. State saved before
  // kinds existed only means Code when it was already sending to a default Code session.
  function chosenKind(state) {
    if (!state) return 'claude';
    if (KINDS.indexOf(state.kind) >= 0) return state.kind;
    return state.mode === 'default_chat' && state.selected && /^code:/.test(state.selected.session_id) ? 'code' : 'claude';
  }
  // Claude Code has no new-session option: a new Code session needs a repo and environment.
  function mode(state) {
    return chosenKind(state) === 'code' || (state && state.mode === 'default_chat') ? 'default_chat' : 'new_chat';
  }
  // The saved default, when it is of the chosen kind.
  function defaultChat(state) {
    var prefix = chosenKind(state) === 'code' ? 'code:' : 'chat:';
    return state && state.selected && state.selected.session_id.indexOf(prefix) === 0 ? state.selected : null;
  }
  function status(state) {
    var selected = defaultChat(state);
    return state ? { configured: true, organizations: state.organizations, organization: state.org, kind: chosenKind(state), mode: mode(state),
      selected: selected ? Object.assign({}, selected, { nickname: nickname(state, selected.session_id) }) : null } : { configured: false };
  }
  // A failed POST is reported as uncertain delivery unless the caller says the request sent nothing.
  async function call(state, method, path, body, deliversMessage) {
    var risky = deliversMessage === undefined ? method === 'POST' : deliversMessage;
    var headers = { Cookie: 'sessionKey=' + state.cookie, Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8', Origin: ORIGIN, Referer: ORIGIN + '/' };
    if (state.org) headers.Cookie += '; lastActiveOrg=' + state.org;
    if (path.indexOf('/v1/code/') === 0) {
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-beta'] = 'ccr-byoc-2025-07-29';
      headers['anthropic-client-feature'] = 'ccr';
      headers['anthropic-client-platform'] = 'web_claude_ai';
      headers['x-organization-uuid'] = state.org;
    }
    if (path.endsWith('/completion')) headers.Accept = 'text/event-stream';
    var response;
    try {
      response = await fetch(ORIGIN + path, { method: method, headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (_) {
      if (risky) throw uncertain();
      throw PluginError('PLUGIN_UNAVAILABLE', 'Could not reach Claude. Try opening Claude in your browser.');
    }
    if (response.status === 401) throw PluginError('AUTH_REQUIRED', 'Claude sign-in expired. Sign in again in settings.');
    if (response.status === 403) throw PluginError('PERMISSION_DENIED', 'Claude blocked this request. Open Claude to check sign-in, browser verification, or organization access.');
    if (response.status === 409) throw PluginError('PLUGIN_UNAVAILABLE', 'Claude reported a session conflict (HTTP 409). Read the session to check its current state before sending again; do not automatically retry.');
    if (response.status === 429) throw PluginError('RATE_LIMITED', 'Claude is rate limiting requests. Wait before trying again.');
    if (response.status === 404) throw PluginError('NOT_FOUND', 'This Claude session is no longer available in the selected organization.');
    if (response.status < 200 || response.status >= 300) {
      if (risky && response.status >= 500) throw uncertain();
      throw PluginError('PLUGIN_UNAVAILABLE', 'Claude rejected the request (HTTP ' + response.status + ').');
    }
    return response;
  }
  async function json(state, path) {
    var response = await call(state, 'GET', path);
    try { return await response.json(); } catch (_) { throw unavailable(); }
  }
  async function organizations(cookie) {
    var rows = await json({ cookie: cookie }, '/api/organizations');
    if (!Array.isArray(rows) || rows.length === 0) throw unavailable();
    return rows.map(function (row) {
      if (!row || !UUID.test(row.uuid)) throw unavailable();
      return { id: row.uuid, name: typeof row.name === 'string' ? row.name : row.uuid };
    });
  }
  function cursorParam(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return '';
    if (typeof cursor !== 'string' || cursor.length > 4096) throw invalid('Invalid pagination cursor.');
    return '&cursor=' + encodeURIComponent(cursor);
  }
  async function list(state, args) {
    orgPath(state);
    var kind = args.kind || 'chat';
    if (kind !== 'chat' && kind !== 'code') throw invalid('Choose chat or code.');
    var path = kind === 'chat' ? orgPath(state) + '/chat_conversations' : '/v1/code/sessions';
    var data = await json(state, path + '?limit=100' + cursorParam(args.cursor));
    var rows = Array.isArray(data) ? data : data && (kind === 'code' ? data.data : data.conversations || data.items);
    if (!Array.isArray(rows)) throw unavailable();
    var sessions = rows.map(function (row) {
      var id = kind === 'chat' ? row.uuid : row.id;
      sessionRef(kind + ':' + id);
      return { session_id: kind + ':' + id, kind: kind,
        nickname: nickname(state, kind + ':' + id), isDefault: !!defaultChat(state) && state.selected.session_id === kind + ':' + id,
        title: (kind === 'chat' ? row.name : row.title) || 'Untitled',
        status: row.status || '', connection: row.connection_status || '',
        updated_at: row.updated_at || row.last_event_at || '',
        url: ORIGIN + '/' + kind + '/' + id };
    });
    sessions.sort(function (a, b) { return (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0); });
    var next = Array.isArray(data) ? null : data.next_cursor || data.cursor || null;
    if (next !== null && typeof next !== 'string') throw unavailable();
    return { sessions: sessions, next_cursor: next };
  }
  async function detail(state, ref) {
    var path = ref.kind === 'chat' ? orgPath(state) + '/chat_conversations/' + ref.id +
      '?tree=True&rendering_mode=messages&render_all_tools=true' : '/v1/code/sessions/' + ref.id;
    var data = await json(state, path);
    if (ref.kind === 'code' && data && data.response_shape) data = data.response_shape;
    if (!data || (ref.kind === 'chat' ? data.uuid : data.id) !== ref.id) throw unavailable();
    return data;
  }
  async function config(message) {
    switch (message && message.type) {
      case 'status': return status(await load());
      case 'connect': {
        if (!validCookie(message.session_key)) throw invalid('Claude sign-in did not return a valid session.');
        var orgs = await organizations(message.session_key);
        var state = { cookie: message.session_key, organizations: orgs, org: orgs.length === 1 ? orgs[0].id : null };
        await save(state);
        return status(state);
      }
      case 'mode': {
        var state = await required();
        if (MODES.indexOf(message.mode) < 0) throw invalid('Choose new_chat or default_chat.');
        state.mode = message.mode;
        await save(state);
        return status(state);
      }
      case 'kind': {
        var state = await required();
        if (KINDS.indexOf(message.kind) < 0) throw invalid('Choose claude or code.');
        state.kind = message.kind;
        await save(state);
        return status(state);
      }
      case 'organization': {
        var state = await required();
        var orgs = await organizations(state.cookie);
        if (!orgs.some(function (org) { return org.id === message.id; })) throw invalid('Choose one of your Claude organizations.');
        state.org = message.id;
        state.organizations = orgs;
        state.selected = null;
        await save(state);
        return status(state);
      }
      case 'list': return list(await required(), message);
      case 'save_session':
      case 'select': {
        var state = await required(), ref = sessionRef(message.session_id);
        if (message.kind !== undefined && message.kind !== (ref.kind === 'code' ? 'code' : 'claude')) {
          throw invalid(message.kind === 'code' ? 'Choose a Claude Code session.' : 'Choose a Claude chat.');
        }
        orgPath(state);
        var data = await detail(state, ref);
        if (message.type === 'save_session') {
          if (typeof message.nickname !== 'string' || message.nickname.trim().length > 40) throw invalid('Use a nickname of at most 40 characters.');
          var name = message.nickname.trim(), names = nicknames(state);
          if (NEW_CHAT.indexOf(name.toLowerCase()) >= 0) throw invalid('“' + name + '” is reserved for starting a new chat. Choose another nickname.');
          Object.keys(names).forEach(function (id) {
            if (name && names[id].toLowerCase() === name.toLowerCase()) delete names[id];
          });
          if (name) names[ref.ref] = name; else delete names[ref.ref];
          if (!state.nicknamesByOrg) state.nicknamesByOrg = {};
          state.nicknamesByOrg[state.org] = names;
        }
        if (message.type === 'select' || message.makeDefault === true) {
          state.selected = { session_id: ref.ref, title: (ref.kind === 'chat' ? data.name : data.title) || 'Untitled' };
          state.kind = ref.kind === 'code' ? 'code' : 'claude';
        }
        await save(state);
        return status(state);
      }
      case 'disconnect': await storage.removeItem(KEY); return status(null);
      default: throw invalid('Unknown settings request.');
    }
  }
  async function createChat(state) {
    var id = requestId();
    var response = await call(state, 'POST', orgPath(state) + '/chat_conversations', { uuid: id, name: '' }, false);
    var data;
    try { data = await response.json(); } catch (_) { throw PluginError('PLUGIN_UNAVAILABLE', 'Could not start a new Claude chat. Nothing was sent.'); }
    if (!data || data.uuid !== id) throw PluginError('PLUGIN_UNAVAILABLE', 'Could not start a new Claude chat. Nothing was sent.');
    return data;
  }
  // Posts one human turn under [parent] and returns the delivered message id, or throws uncertain().
  async function completeChat(state, chatId, data, parent, text) {
    var id = requestId(), assistantId = requestId();
    var body = { prompt: text, parent_message_uuid: parent,
      turn_message_uuids: { human_message_uuid: id, assistant_message_uuid: assistantId },
      timezone: 'UTC', locale: 'en-US', attachments: [], files: [], sync_sources: [], rendering_mode: 'messages' };
    if (typeof data.model === 'string' && data.model) body.model = data.model;
    var response = await call(state, 'POST', orgPath(state) + '/chat_conversations/' + chatId + '/completion', body);
    var accepted = false;
    try {
      var serverId = completionReceipt(await response.text(), assistantId, id);
      if (serverId) { id = serverId; accepted = true; }
    } catch (_) { /* Verify persisted human message below. */ }
    if (!accepted) {
      try {
        var after = await detail(state, sessionRef('chat:' + chatId));
        accepted = Array.isArray(after.chat_messages) && after.chat_messages.some(function (m) {
          return m.uuid === id && m.sender === 'human';
        });
      } catch (_) { /* A failed read cannot establish delivery. */ }
    }
    if (!accepted) throw uncertain();
    return id;
  }
  async function send(state, ref, text) {
    if (ref.isNew) {
      var chat = await createChat(state);
      var messageId = await completeChat(state, chat.uuid, chat, ROOT_MESSAGE, text);
      return { text: 'Message submitted to Claude in a new chat.', session_id: 'chat:' + chat.uuid,
        message_id: messageId, url: ORIGIN + '/chat/' + chat.uuid };
    }
    var data = await detail(state, ref), id = requestId();
    if (ref.kind === 'code') {
      if (data.status === 'archived') throw invalid('This Code session is archived. Reopen it in Claude first.');
      if (data.environment_kind === 'bridge' && data.connection_status !== 'connected') {
        throw PluginError('PLUGIN_UNAVAILABLE', 'This Claude Code session is offline. Reconnect it in Claude Code first.');
      }
      var response = await call(state, 'POST', '/v1/code/sessions/' + ref.id + '/events', {
        session_id: ref.id, events: [{ payload: { type: 'user', uuid: id,
          message: { role: 'user', content: [{ type: 'text', text: text }] } } }],
      });
      var receipt;
      try { receipt = await response.json(); } catch (_) { throw uncertain(); }
      if (!receipt || !Array.isArray(receipt.results) || receipt.results.length !== 1 || !receipt.results[0].event_id) throw uncertain();
    } else {
      var branch = chatBranch(data), leaf = branch.messages[branch.messages.length - 1];
      if (leaf.sender !== 'assistant' || data.is_streaming) throw invalid('Wait for Claude to finish the current reply before sending.');
      id = await completeChat(state, ref.id, data, branch.leaf, text);
    }
    return { text: 'Message submitted to Claude: ' + ((ref.kind === 'chat' ? data.name : data.title) || 'Untitled') + '.',
      session_id: ref.ref, message_id: id, url: ORIGIN + '/' + ref.kind + '/' + ref.id };
  }
  async function resolve(state, chatId) {
    if (chatId !== undefined && chatId !== null && typeof chatId !== 'string') throw invalid('Name a Claude chat.');
    var query = (chatId || '').trim().toLowerCase();
    if (NEW_CHAT.indexOf(query) >= 0 || (!query && mode(state) === 'new_chat')) return { kind: 'chat', id: null, ref: 'chat:new', isNew: true };
    if (!query) {
      var selected = defaultChat(state);
      if (!selected) throw invalid(chosenKind(state) === 'code' ? 'No default Claude Code session yet. Pick one in settings, or name a chat.' :
        'No default Claude chat yet. Pick one in settings, or name a chat.');
      return sessionRef(selected.session_id);
    }
    if (/^(chat|code):/.test(query)) return sessionRef(chatId.trim());
    var names = nicknames(state), ids = Object.keys(names);
    var exact = ids.filter(function (id) { return names[id].toLowerCase() === query; });
    if (exact.length === 1) return sessionRef(exact[0]);
    var partial = ids.filter(function (id) { return names[id].toLowerCase().indexOf(query) >= 0; });
    if (partial.length === 1) return sessionRef(partial[0]);
    if (partial.length > 1) throw invalid('Multiple Claude nicknames match. Use an exact nickname or chat id.');
    var matches = [];
    for (var kind of ['chat', 'code']) {
      var cursor = null, seen = Object.create(null), pages = 0;
      do {
        if (++pages > 50 || (cursor && seen[cursor])) throw invalid('Could not search every chat. Use an exact nickname or chat id.');
        if (cursor) seen[cursor] = true;
        var page = await list(state, { kind: kind, cursor: cursor });
        page.sessions.forEach(function (row) {
          if (row.session_id.split(':')[1].toLowerCase() === query || row.title.toLowerCase().indexOf(query) >= 0) {
            if (!matches.some(function (other) { return other.session_id === row.session_id; })) matches.push(row);
          }
        });
        cursor = page.next_cursor;
      } while (cursor);
    }
    if (matches.length !== 1) throw invalid(matches.length ? 'Multiple Claude chats match. Use a nickname or exact chat id.' : 'No Claude chat matches that name. Choose one from agent/chats or in settings.');
    return sessionRef(matches[0].session_id);
  }
  async function action(request) {
    var args = request && request.args || {};
    if (!request || request.action !== 'send_to_agent') throw invalid('Unknown action.');
    if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 16000) {
      throw invalid('Provide a message between 1 and 16,000 characters.');
    }
    var state = await required();
    orgPath(state);
    var ref = await resolve(state, args.chat_id);
    if (sending) throw invalid('A Claude message is already being sent. Check it before sending another.');
    sending = true;
    try { return await send(state, ref, args.message); } finally { sending = false; }
  }
  async function source(request) {
    if (!request || request.category !== 'agent') throw invalid('Unsupported Claude source.');
    var state = await load(), selected = defaultChat(state), newChat = mode(state) === 'new_chat';
    if (request.item === 'configured') {
      var ready = !!state && (newChat ? UUID.test(state.org) : !!selected);
      var name = !state ? '' : newChat ? 'New chat' : selected ? nickname(state, selected.session_id) || selected.title : '';
      var hint = ready ? 'Connected' : !state || newChat ? 'Sign in in settings' :
        chosenKind(state) === 'code' ? 'Choose a Claude Code session in settings' : 'Choose a chat in settings';
      return { validUntilMs: now() + 60000, instances: [{ instanceId: 'claude', properties: {
        name: { shortText: { text: name } },
        configured: { boolean: { value: ready }, shortText: { text: hint } },
      } }] };
    }
    if (request.item !== 'chats') throw invalid('Unsupported Claude source.');
    state = await required();
    orgPath(state);
    var rows = [];
    for (var kind of ['chat', 'code']) rows = rows.concat((await list(state, { kind: kind })).sessions);
    rows.sort(function (a, b) { return (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0); });
    return { validUntilMs: now() + 900000, instances: rows.map(function (row) {
      return { instanceId: row.session_id, properties: {
        name: { shortText: { text: row.nickname || row.title } },
        title: { shortText: { text: row.title } },
        url: { longText: { text: row.url } },
      } };
    }) };
  }
  return { config: config, action: action, source: source };
}
function safeError(error) {
  return error && error.code ? { code: error.code, message: error.message } :
    { code: 'PLUGIN_UNAVAILABLE', message: 'Claude request failed. If sending, delivery may be uncertain; check Claude before retrying.' };
}
var service = createService(Pebble.secureStorage, fetch, Date.now);
Pebble.registerActionHandler(function (request, response) {
  service.action(request).then(response.ok, function (error) { var e = safeError(error); response.error(e.code, e.message); });
});
Pebble.registerSourceHandler(function (request, response) {
  service.source(request).then(response.data, function (error) { var e = safeError(error); response.error(e.code, e.message); });
});
Pebble.registerConfigHandler(function (message, respond) {
  service.config(message).then(respond, function (error) { respond({ error: safeError(error).message }); });
});
